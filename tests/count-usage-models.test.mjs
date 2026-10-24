import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectUsage, formatTable } from '../scripts/count-usage.mjs';

const FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens',
  'cache_read_input_tokens', 'total_tokens', 'total_without_cache_read_tokens'];
const now = new Date('2026-10-24T04:00:00Z');
const timestamp = minute => `2026-10-23T03:${String(minute).padStart(2, '0')}:00Z`;
const claude = (id, model, input, minute = 0) => ({
  type: 'assistant', timestamp: timestamp(minute), message: {
    id, model, content: 'PRIVATE_BODY_DO_NOT_EXPORT', usage: {
      input_tokens: input, output_tokens: 2,
      cache_creation_input_tokens: 3, cache_read_input_tokens: 5,
    },
  },
});
const meta = (id, model) => ({ type: 'session_meta', payload: { id, model } });
const context = model => ({ type: 'turn_context', payload: { model,
  developer_instructions: 'PRIVATE_CONTEXT_DO_NOT_EXPORT' } });
const tokens = (minute, input, output, cached, last = null) => ({
  type: 'event_msg', timestamp: timestamp(minute), payload: {
    type: 'token_count', info: {
      total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached },
      last_token_usage: last ?? { input_tokens: input, output_tokens: output, cached_input_tokens: cached },
    },
  },
});

async function logs(t, files) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(tempRoot, 'yak-model-test-'));
  const originals = [];
  t.after(async () => {
    try {
      for (const [name, bytes] of originals) assert.deepEqual(await readFile(name), bytes);
    } finally {
      assert.equal(path.dirname(path.resolve(root)), tempRoot);
      assert.equal(path.basename(root).startsWith('yak-model-test-'), true);
      await rm(root, { recursive: true, force: true });
    }
  });
  for (const [relative, records] of Object.entries(files)) {
    const filename = path.join(root, relative);
    const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n');
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes);
    originals.push([filename, bytes]);
  }
  return {
    root,
    options: { claudeRoot: path.join(root, 'claude'), codexRoot: path.join(root, 'codex'),
      days: 7, now, includeModels: true },
  };
}

function reconcile(report) {
  for (const daily of report.daily) {
    const models = report.by_model_daily.filter(row => row.date === daily.date && row.tool === daily.tool);
    for (const field of FIELDS) {
      assert.equal(models.reduce((sum, row) => sum + row[field], 0), daily[field],
        `${daily.date} ${daily.tool} ${field} 模型逐项对账`);
    }
  }
  for (const total of report.totals) {
    const models = report.by_model_daily.filter(row => total.tool === '合计' || row.tool === total.tool);
    for (const field of FIELDS) {
      assert.equal(models.reduce((sum, row) => sum + row[field], 0), total[field],
        `${total.tool} ${field} 全期逐项对账`);
    }
  }
}

const byModel = (report, tool, model) => report.by_model_daily.find(row => row.tool === tool && row.model === model);

test('Claude 模型跟随去重后较大的完整计数，日期仍是首次记录', async t => {
  const { options } = await logs(t, {
    'claude/00.jsonl': [claude('message-private', 'claude-small', 1),
      claude('message-private', 'claude-large', 20, 2)],
    'claude/10-copy.jsonl': [claude('message-private', 'claude-small', 2, 3)],
  });
  const { report } = await collectUsage(options);
  assert.equal(report.by_model_daily.length, 1);
  assert.equal(byModel(report, 'Claude Code', 'claude-large').total_tokens, 30);
  assert.equal(report.by_model_daily[0].date, '2026-10-23');
  reconcile(report);
});

test('Codex 同一会话切换模型后按整个会话累计差分，不按模型重复计算累计', async t => {
  const { options } = await logs(t, { 'codex/main.jsonl': [
    meta('session-private', 'gpt-meta'), context('gpt-a'), tokens(0, 100, 10, 20),
    context('gpt-b'), tokens(1, 150, 15, 30),
    context('gpt-a'), tokens(2, 175, 20, 35),
  ] });
  const { report } = await collectUsage(options);
  assert.equal(byModel(report, 'Codex', 'gpt-a').total_tokens, 140);
  assert.equal(byModel(report, 'Codex', 'gpt-b').total_tokens, 55);
  assert.equal(report.totals.find(row => row.tool === 'Codex').total_tokens, 195);
  assert.equal(byModel(report, 'Codex', 'gpt-meta'), undefined);
  reconcile(report);
});

test('Codex 重复文件只计一次，相同事件副本可补已知模型且不改变累计差分', async t => {
  const { options } = await logs(t, {
    'codex/00-copy.jsonl': [meta('session-private'), tokens(0, 100, 10, 20), tokens(1, 150, 15, 30)],
    'codex/10-main.jsonl': [meta('session-private'), context('gpt-a'), tokens(0, 100, 10, 20),
      context('gpt-b'), tokens(1, 150, 15, 30)],
  });
  const { report } = await collectUsage(options);
  assert.equal(report.by_model_daily.length, 2);
  assert.equal(byModel(report, 'Codex', 'gpt-a').total_tokens, 110);
  assert.equal(byModel(report, 'Codex', 'gpt-b').total_tokens, 55);
  reconcile(report);
});

test('Codex 使用会话元数据回退模型，缺失或新会话不借用别的会话模型', async t => {
  const { options } = await logs(t, {
    'codex/00.jsonl': [meta('session-a-private', 'gpt-meta'), tokens(0, 20, 2, 5)],
    'codex/20.jsonl': [meta('session-c-private'), tokens(2, 40, 4, 10)],
    'codex/10.jsonl': [meta('session-b-private'), tokens(1, 30, 3, 10)],
  });
  const { report } = await collectUsage(options);
  assert.equal(byModel(report, 'Codex', 'gpt-meta').total_tokens, 22);
  assert.equal(byModel(report, 'Codex', 'unknown').total_tokens, 77);
  reconcile(report);
});

test('模型标识限制 ASCII 和长度，正文、上下文、路径、会话和消息编号均不输出', async t => {
  const safe128 = 'm'.repeat(128);
  const { options, root } = await logs(t, {
    'claude/main.jsonl': [claude('message-private-1', '../secret-path', 1),
      claude('message-private-2', '含中文', 2), claude('message-private-3', 'bad\nmodel', 3),
      claude('message-private-4', 'm'.repeat(129), 4), claude('message-private-5', safe128, 5),
      claude('message-private-6', undefined, 6)],
    'codex/main.jsonl': [meta('session-private', 'gpt-valid'), tokens(0, 10, 1, 0),
      context('C:\\private\\model'), tokens(1, 20, 2, 0),
      context('contains space'), tokens(2, 30, 3, 0)],
  });
  const { report } = await collectUsage(options);
  assert.equal(byModel(report, 'Claude Code', safe128).total_tokens, 15);
  assert.equal(byModel(report, 'Codex', 'unknown').total_tokens, 22);
  const serialized = JSON.stringify(report);
  for (const forbidden of ['PRIVATE_BODY_DO_NOT_EXPORT', 'PRIVATE_CONTEXT_DO_NOT_EXPORT',
    '../secret-path', '含中文', 'bad\\nmodel', 'm'.repeat(129), 'C:\\\\private',
    'contains space', 'message-private', 'session-private', root]) {
    assert.equal(serialized.includes(forbidden), false, `不得输出 ${forbidden}`);
  }
  for (const row of report.by_model_daily) assert.match(row.model, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  reconcile(report);
});

test('窗口前累计仍提供跨模型基线，重置时仅计本次且归当前模型', async t => {
  const baseline = tokens(0, 100, 10, 20);
  baseline.timestamp = '2026-10-16T03:00:00Z';
  const { options } = await logs(t, { 'codex/main.jsonl': [
    meta('session-private', 'gpt-old'), baseline, context('gpt-new'), tokens(1, 150, 15, 30),
    context('gpt-reset'), tokens(2, 40, 4, 10),
  ] });
  const { report } = await collectUsage(options);
  assert.equal(byModel(report, 'Codex', 'gpt-old'), undefined);
  assert.equal(byModel(report, 'Codex', 'gpt-new').total_tokens, 55);
  assert.equal(byModel(report, 'Codex', 'gpt-reset').total_tokens, 44);
  reconcile(report);
});

test('可选模型行与原工具每日及总计六字段精确一致，默认报告和表格保持原样', async () => {
  const fixture = name => fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
  const options = { claudeRoot: fixture('claude'), codexRoot: fixture('codex'),
    days: 7, now: new Date('2026-10-23T04:00:00Z') };
  const original = await collectUsage(options);
  const extended = await collectUsage({ ...options, includeModels: true });
  assert.deepEqual(Object.keys(original.report), ['daily', 'totals']);
  assert.deepEqual(extended.report.daily, original.report.daily);
  assert.deepEqual(extended.report.totals, original.report.totals);
  assert.deepEqual(extended.diagnostics, original.diagnostics);
  assert.equal(formatTable(extended.report), formatTable(original.report));
  assert.equal(original.report.totals.at(-1).total_tokens, 369);
  reconcile(extended.report);
});

test('无日志的扩展报告返回空模型行，默认报告不增加字段', async t => {
  const { options } = await logs(t, {});
  const extended = await collectUsage(options);
  const original = await collectUsage({ ...options, includeModels: false });
  assert.deepEqual(extended.report.by_model_daily, []);
  assert.equal(Object.hasOwn(original.report, 'by_model_daily'), false);
  reconcile(extended.report);
});
