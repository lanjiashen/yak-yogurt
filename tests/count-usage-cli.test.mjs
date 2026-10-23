import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/count-usage.mjs', import.meta.url));
const totalFor = (report, tool) => report.totals.find(row => row.tool === tool);
const stringifyLines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

async function isolatedHome(t, withLogs = true) {
  // 每个子进程只读自己的假主目录，不会接触测试者的真实 Claude/Codex 日志。
  const temporaryRoot = path.resolve(os.tmpdir());
  const home = await mkdtemp(path.join(temporaryRoot, '有酸奶 CLI 测试 '));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TZ: 'America/Los_Angeles' };
  const probe = spawnSync(process.execPath,
    ['--input-type=module', '-e', "import os from 'node:os'; process.stdout.write(os.homedir());"],
    { env, encoding: 'utf8', timeout: 15_000 });
  const originals = [];
  t.after(async () => {
    try {
      for (const [filename, bytes] of originals) {
        assert.deepEqual(await readFile(filename), bytes, 'CLI 不得修改原始假日志');
      }
    } finally {
      assert.equal(path.dirname(path.resolve(home)), temporaryRoot, '只清理本测试创建的临时目录');
      assert.equal(path.basename(home).startsWith('有酸奶 CLI 测试 '), true);
      await rm(home, { recursive: true, force: true });
    }
  });
  assert.equal(probe.status, 0, '假主目录隔离检查必须成功');
  assert.equal(probe.stdout === home, true, 'HOME/USERPROFILE 必须指向假主目录后才可运行 CLI');

  let fixtureDate;
  if (withLogs) {
    // 使用运行时附近的日期，不让 CLI 冒烟测试随日历日期过期。
    const timestamp = new Date(Date.now() - 2_000).toISOString();
    fixtureDate = new Date(Date.parse(timestamp) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const claude = path.join(home, '.claude', 'projects', '项目 with spaces', 'usage.jsonl');
    const codex = path.join(home, '.codex', 'sessions', 'year', 'month', 'usage.jsonl');
    const records = [
      [claude, [{
        type: 'assistant', timestamp,
        message: { id: 'fake-cli-message', content: 'FAKE_PRIVATE_CLI_CONTENT', usage: {
          input_tokens: 11, output_tokens: 7,
          cache_creation_input_tokens: 3, cache_read_input_tokens: 5,
        } },
      }]],
      [codex, [
        { type: 'session_meta', payload: { id: 'fake-cli-session' } },
        { type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 40, output_tokens: 9, cached_input_tokens: 23 },
          last_token_usage: { input_tokens: 40, output_tokens: 9, cached_input_tokens: 23 },
        } } },
      ]],
    ];
    for (const [filename, rows] of records) {
      const bytes = Buffer.from(stringifyLines(rows));
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, bytes);
      originals.push([filename, bytes]);
    }
  }
  const run = args => {
    // 从不同于工程目录的位置启动，覆盖绝对脚本路径和中文空格目录。
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: home, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 1_048_576,
    });
    assert.equal(result.error, undefined, 'CLI 子进程必须在限时内启动并退出');
    assert.equal(result.signal, null, 'CLI 不得被信号中止');
    for (const forbidden of ['FAKE_PRIVATE_CLI_CONTENT', 'fake-cli-message', 'fake-cli-session', home]) {
      assert.equal((result.stdout + result.stderr).includes(forbidden), false,
        'CLI 不得输出正文、内部编号或主目录路径');
    }
    return result;
  };
  return { run, fixtureDate };
}

test('CLI 默认发现中文空格主目录的两工具日志，并输出正确 JSON', async t => {
  const { run, fixtureDate } = await isolatedHome(t);
  const result = run(['--json']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.daily.length, 14, '默认最近七个北京日期，每日两工具');
  assert.equal(report.daily.find(row => row.tool === 'Claude Code' && row.total_tokens > 0).date,
    fixtureDate, '进程时区不在中国时仍归入北京日期');
  assert.equal(totalFor(report, 'Claude Code').total_tokens, 26);
  assert.deepEqual(totalFor(report, 'Codex'), {
    tool: 'Codex', input_tokens: 17, output_tokens: 9,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 23,
    total_tokens: 49, total_without_cache_read_tokens: 26,
  });
  assert.equal(totalFor(report, '合计').total_tokens, 75);
  assert.equal(totalFor(report, '合计').total_without_cache_read_tokens, 47);
});

test('CLI 无参数输出中文表格，支持指定天数，退出码为零', async t => {
  const { run } = await isolatedHome(t);
  const result = run([]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /日期\s+工具\s+输入\s+输出\s+缓存写入\s+缓存读取/);
  assert.match(result.stdout, /合计\s+合计\s+28\s+16\s+3\s+28\s+75\s+47/);
  const threeDays = run(['--days', '3', '--json']);
  assert.equal(threeDays.status, 0);
  const report = JSON.parse(threeDays.stdout);
  assert.equal(report.daily.length, 6);
  assert.equal(totalFor(report, '合计').total_tokens, 75);
});

test('CLI 无日志时成功输出零值，诊断只进标准错误', async t => {
  const { run } = await isolatedHome(t, false);
  const result = run(['--json']);
  assert.equal(result.status, 0);
  assert.equal(totalFor(JSON.parse(result.stdout), '合计').total_tokens, 0);
  assert.match(result.stderr, /Claude Code｜没有日志文件：1/);
  assert.match(result.stderr, /Codex｜没有日志文件：1/);
});

test('CLI 无效参数退出码为一，不输出结果或原始日志', async t => {
  const { run } = await isolatedHome(t);
  const result = run(['--days', '0']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /参数错误/);
});
