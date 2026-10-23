import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectUsage, formatTable, parseArgs } from '../scripts/count-usage.mjs';

const fixture = name => fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
const options = {
  claudeRoot: fixture('claude'), codexRoot: fixture('codex'),
  days: 7, now: new Date('2026-10-23T04:00:00.000Z'),
};
const count = overrides => collectUsage({ ...options, ...overrides });
const usage = (input, output, write, read) => ({
  input_tokens: input, output_tokens: output,
  cache_creation_input_tokens: write, cache_read_input_tokens: read,
  total_tokens: input + output + write + read,
  total_without_cache_read_tokens: input + output + write,
});
const totalFor = (report, tool) => report.totals.find(row => row.tool === tool);
const dayFor = (report, date, tool) => report.daily.find(row => row.date === date && row.tool === tool);

test('参数默认七天，支持 JSON 和指定天数，拒绝无效参数', () => {
  assert.deepEqual(parseArgs([]), { days: 7, json: false });
  assert.deepEqual(parseArgs(['--json', '--days', '3']), { days: 3, json: true });
  for (const args of [['--days'], ['--days', '0'], ['--days', '-1'],
    ['--days', '1.5'], ['--days', 'abc'], ['--unknown'], ['--json', '--json']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('Claude 按消息编号跨文件去重，流式版本只取最终较大的用量', async () => {
  const { report, diagnostics } = await count();
  assert.deepEqual(totalFor(report, 'Claude Code'), { tool: 'Claude Code', ...usage(60, 16, 11, 26) });
  assert.equal(dayFor(report, '2026-10-17', 'Claude Code').total_tokens, 25);
  assert.equal(dayFor(report, '2026-10-23', 'Claude Code').output_tokens, 9);
  assert.deepEqual(diagnostics, {});
});

test('Codex 扣除输入内含缓存，累计差值去重，处理重置及继承基线', async () => {
  const { report } = await count();
  assert.deepEqual(totalFor(report, 'Codex'), { tool: 'Codex', ...usage(93, 46, 12, 105) });
  assert.deepEqual(dayFor(report, '2026-10-17', 'Codex'),
    { date: '2026-10-17', tool: 'Codex', ...usage(25, 15, 5, 30) });
  assert.equal(dayFor(report, '2026-10-23', 'Codex').total_tokens, 131);
});

test('北京时间零点切日，包含今天共七天，忽略窗口前和未来记录', async () => {
  const { report } = await count();
  assert.equal(report.daily.length, 14);
  assert.equal(report.daily[0].date, '2026-10-17');
  assert.equal(report.daily.at(-1).date, '2026-10-23');
  assert.equal(dayFor(report, '2026-10-22', 'Claude Code').total_tokens, 38);
  const { report: oneDay } = await count({ days: 1 });
  assert.equal(oneDay.daily.length, 2);
  assert.equal(totalFor(oneDay, '合计').total_tokens, 181);
});

test('四类相加等于合计，扣除缓存读取后与第二合计一致', async () => {
  const { report } = await count();
  assert.deepEqual(totalFor(report, '合计'), { tool: '合计', ...usage(153, 62, 23, 131) });
  for (const row of [...report.daily, ...report.totals]) {
    assert.equal(row.total_tokens - row.cache_read_input_tokens, row.total_without_cache_read_tokens);
  }
});

test('表格和 JSON 只含日期、工具及数字，不泄露正文、编号或路径', async () => {
  const { report } = await count();
  const table = formatTable(report);
  assert.match(table, /日期.*工具.*输入.*输出.*缓存写入.*缓存读取.*合计.*不含缓存读取/);
  assert.match(table, /2026-10-17/);
  assert.match(table, /369/);
  const serialized = JSON.stringify(report);
  for (const forbidden of ['FAKE_PRIVATE_CONTENT', 'message-', 'fake-session', fixture(''), 'content']) {
    assert.equal((table + serialized).includes(forbidden), false);
  }
  for (const row of [...JSON.parse(serialized).daily, ...report.totals]) {
    for (const [key, value] of Object.entries(row)) {
      if (key === 'date') assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
      else if (key === 'tool') assert.ok(['Claude Code', 'Codex', '合计'].includes(value));
      else assert.equal(typeof value, 'number');
    }
  }
});

test('读取前后假日志字节不变，不写回日志', async () => {
  const names = ['claude/main.jsonl', 'claude/nested/copy.jsonl', 'codex/main.jsonl',
    'codex/nested/copy.jsonl', 'codex/fork.jsonl'];
  const before = await Promise.all(names.map(name => readFile(fixture(name))));
  await count();
  const after = await Promise.all(names.map(name => readFile(fixture(name))));
  after.forEach((bytes, i) => assert.deepEqual(bytes, before[i]));
});

test('缺少日志时零值和诊断分开，损坏尾行不泄露原文且保留完整记录', async () => {
  const missing = fixture('not-present');
  const absent = await count({ claudeRoot: missing, codexRoot: missing });
  assert.equal(totalFor(absent.report, '合计').total_tokens, 0);
  assert.equal(absent.diagnostics['Claude Code｜没有日志文件'], 1);
  assert.equal(absent.diagnostics['Codex｜没有日志文件'], 1);
  const broken = await count({ claudeRoot: fixture('broken'), codexRoot: missing });
  assert.equal(totalFor(broken.report, 'Claude Code').total_tokens, 3);
  assert.equal(broken.diagnostics['Claude Code｜无法解析的记录'], 1);
});
