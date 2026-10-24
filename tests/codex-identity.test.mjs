import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectUsage } from '../scripts/count-usage.mjs';

const FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens',
  'cache_read_input_tokens', 'total_tokens', 'total_without_cache_read_tokens'];
const now = new Date('2026-10-24T04:00:00Z');
const beforeToday = '2026-10-23T15:59:59Z';
const firstToday = '2026-10-23T16:00:00Z';
const secondToday = '2026-10-23T16:00:01Z';
const ROOT_ID = 'root-thread-private';

function meta(id, { sessionId = ROOT_ID, parentId = ROOT_ID } = {}) {
  return { type: 'session_meta', timestamp: '2026-10-23T14:00:00Z', payload: {
    id, session_id: sessionId, parent_thread_id: parentId,
  } };
}
function context(model, turnId) {
  return { type: 'turn_context', payload: { model, turn_id: turnId,
    developer_instructions: 'PRIVATE_CONTEXT_DO_NOT_EXPORT' } };
}
function started(turnId, startedAt) {
  return { type: 'event_msg', timestamp: startedAt, payload: {
    type: 'task_started', turn_id: turnId, started_at: startedAt,
  } };
}
function counters(input, cached, output) {
  return { input_tokens: input, cached_input_tokens: cached,
    cache_write_input_tokens: 0, output_tokens: output,
    total_tokens: input + output, reasoning_output_tokens: 0 };
}
function tokens(timestamp, total, last = total) {
  return { type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
    total_token_usage: counters(...total), last_token_usage: counters(...last),
  } } };
}
function child(childId, branch, eventTime, next, last) {
  return [
    meta(childId),
    // 分页保留的父会话元信息不应覆盖文件第一个 meta.id。
    meta(ROOT_ID, { parentId: 'older-root-private' }),
    context(`gpt-${branch}`, `${branch}-baseline-private`),
    tokens(beforeToday, [100, 80, 10]),
    context(`gpt-${branch}`, `${branch}-turn-private`),
    started(`${branch}-turn-private`, eventTime),
    tokens(eventTime, next, last),
  ];
}

async function collect(t, files, overrides = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(tempRoot, 'yak-identity-test-'));
  const originals = [];
  t.after(async () => {
    try {
      for (const [filename, bytes] of originals) {
        assert.deepEqual(await readFile(filename), bytes, '统计不得改写测试日志');
      }
    } finally {
      assert.equal(path.dirname(path.resolve(directory)), tempRoot);
      assert.equal(path.basename(directory).startsWith('yak-identity-test-'), true);
      await rm(directory, { recursive: true, force: true });
    }
  });
  for (const [name, records] of Object.entries(files)) {
    const filename = path.join(directory, 'codex', name);
    const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n');
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes);
    originals.push([filename, bytes]);
  }
  return collectUsage({ claudeRoot: path.join(directory, 'claude-absent'),
    codexRoot: path.join(directory, 'codex'), days: 1, now, includeModels: true, ...overrides });
}
function codexTotal(report) {
  return report.totals.find(row => row.tool === 'Codex');
}
function normalized(input, cached, output) {
  return { input_tokens: input - cached, output_tokens: output,
    cache_creation_input_tokens: 0, cache_read_input_tokens: cached,
    total_tokens: input + output, total_without_cache_read_tokens: input - cached + output };
}
function assertOnlyMissingClaude(diagnostics) {
  assert.deepEqual(diagnostics, { 'Claude Code｜没有日志文件': 1 });
}
function reconcile(report) {
  for (const row of report.daily) {
    const models = report.by_model_daily.filter(model => model.date === row.date && model.tool === row.tool);
    for (const field of FIELDS) {
      assert.equal(models.reduce((sum, model) => sum + model[field], 0), row[field],
        `${row.date} ${row.tool} ${field} 模型必须与日期汇总逐项一致`);
    }
  }
  for (const total of report.totals) {
    const days = report.daily.filter(day => total.tool === '合计' || day.tool === total.tool);
    for (const field of FIELDS) {
      assert.equal(days.reduce((sum, day) => sum + day[field], 0), total[field],
        `${total.tool} ${field} 日期必须与全期汇总逐项一致`);
    }
  }
}

const branchA = () => child('child-a-private', 'a', firstToday, [150, 100, 15], [50, 20, 5]);
const branchB = () => child('child-b-private', 'b', secondToday, [160, 140, 20], [60, 60, 10]);

test('Codex 首个 meta.id 固定当前线程，后续父 meta 和共享 session_id 不合并两个孩子', async t => {
  const { report, diagnostics } = await collect(t, { 'a.jsonl': branchA(), 'b.jsonl': branchB() });
  assert.deepEqual(codexTotal(report), { tool: 'Codex', ...normalized(110, 80, 15) });
  assert.equal(codexTotal(report).total_tokens, 125, '独立分支为 A55 + B70，不能跨分支累计相减');
  assert.equal(report.by_model_daily.find(row => row.model === 'gpt-a').total_tokens, 55);
  assert.equal(report.by_model_daily.find(row => row.model === 'gpt-b').total_tokens, 70);
  assertOnlyMissingClaude(diagnostics);
  reconcile(report);
});

test('Codex 父线程自己的用量与孩子用量独立，不能被孩子内的历史 meta 合并', async t => {
  const parent = [meta(ROOT_ID, { sessionId: ROOT_ID, parentId: 'older-root-private' }),
    context('gpt-parent', 'parent-turn-private'), tokens(secondToday, [20, 5, 2])];
  const { report, diagnostics } = await collect(t, {
    'a.jsonl': branchA(), 'b.jsonl': branchB(), 'parent.jsonl': parent,
  });
  assert.deepEqual(codexTotal(report), { tool: 'Codex', ...normalized(130, 85, 17) });
  assert.equal(report.by_model_daily.find(row => row.model === 'gpt-parent').total_tokens, 22);
  assertOnlyMissingClaude(diagnostics);
  reconcile(report);
});

test('Codex 同一当前线程的完整副本和片段副本幂等，副本可补模型但不增加用量', async t => {
  const full = [...branchA(), context('gpt-b', 'second-turn-private'),
    tokens(secondToday, [210, 130, 25], [60, 30, 10])];
  const withoutContexts = full.filter(record => record.type !== 'turn_context');
  const fragment = [meta('child-a-private'), meta(ROOT_ID),
    tokens(firstToday, [150, 100, 15], [50, 20, 5]),
    tokens(secondToday, [210, 130, 25], [60, 30, 10])];
  const original = await collect(t, { 'main.jsonl': full });
  const copied = await collect(t, { '00-unknown-copy.jsonl': withoutContexts,
    '10-full.jsonl': full, 'nested/20-fragment.jsonl': fragment });
  assert.deepEqual(copied, original);
  assert.equal(codexTotal(copied.report).total_tokens, 125);
  assert.equal(copied.report.by_model_daily.find(row => row.model === 'gpt-a').total_tokens, 55);
  assert.equal(copied.report.by_model_daily.find(row => row.model === 'gpt-b').total_tokens, 70);
  assertOnlyMissingClaude(copied.diagnostics);
  reconcile(copied.report);
});

test('Codex 调换分页文件命名及遍历顺序，独立分支的数字和模型归属不变', async t => {
  const forward = await collect(t, { '00.jsonl': branchA(), 'nested/10.jsonl': branchB() });
  const reverse = await collect(t, { '00.jsonl': branchB(), 'nested/10.jsonl': branchA() });
  assert.deepEqual(reverse, forward);
  assert.equal(codexTotal(reverse.report).total_tokens, 125);
  reconcile(reverse.report);
});

test('Codex 保留窗口前基线并在北京时间零点切日，跨模型后六字段逐项对账', async t => {
  const records = [meta('child-days-private'), meta(ROOT_ID),
    context('gpt-before-window', 'before-window-private'),
    tokens('2026-10-22T15:59:59Z', [100, 80, 10]),
    context('gpt-day-one', 'day-one-private'),
    tokens('2026-10-23T15:59:59Z', [150, 100, 15], [50, 20, 5]),
    context('gpt-day-two', 'day-two-private'),
    tokens('2026-10-23T16:00:00Z', [210, 130, 25], [60, 30, 10])];
  const { report, diagnostics } = await collect(t, { 'main.jsonl': records }, { days: 2 });
  const day = date => report.daily.find(row => row.date === date && row.tool === 'Codex');
  assert.deepEqual(day('2026-10-23'), { date: '2026-10-23', tool: 'Codex', ...normalized(50, 20, 5) });
  assert.deepEqual(day('2026-10-24'), { date: '2026-10-24', tool: 'Codex', ...normalized(60, 30, 10) });
  assert.equal(report.by_model_daily.some(row => row.model === 'gpt-before-window'), false);
  assert.equal(codexTotal(report).total_tokens, 125);
  assertOnlyMissingClaude(diagnostics);
  reconcile(report);
});

test('Codex 首条继承累计仅计 last，不把整个旧累计记到孩子或今天', async t => {
  const records = [meta('child-inherited-private'), meta(ROOT_ID),
    context('gpt-child', 'new-turn-private'),
    tokens(firstToday, [1040, 320, 230], [40, 20, 5])];
  const { report, diagnostics } = await collect(t, { 'main.jsonl': records });
  assert.deepEqual(codexTotal(report), { tool: 'Codex', ...normalized(40, 20, 5) });
  assertOnlyMissingClaude(diagnostics);
  reconcile(report);
});

test('Codex 两个当前线程同一时间不同累计的真实增量都计入', async t => {
  const a = branchA();
  const b = child('child-b-private', 'b', firstToday, [160, 140, 20], [60, 60, 10]);
  const { report, diagnostics } = await collect(t, { 'a.jsonl': a, 'b.jsonl': b });
  assert.equal(codexTotal(report).total_tokens, 125);
  assertOnlyMissingClaude(diagnostics);
  reconcile(report);
});

test('Codex 两个不同当前线程即使同时间同累计同 last 也不互相去重', async t => {
  const a = branchA();
  const b = child('child-b-private', 'b', firstToday, [150, 100, 15], [50, 20, 5]);
  const { report, diagnostics } = await collect(t, { 'a.jsonl': a, 'b.jsonl': b });
  assert.deepEqual(codexTotal(report), { tool: 'Codex', ...normalized(100, 40, 10) });
  assert.equal(codexTotal(report).total_tokens, 110);
  assertOnlyMissingClaude(diagnostics);
  reconcile(report);
});

test('fork复制祖先token历史只在祖先处计一次，复制时间不改变日期归属', async t => {
  const parent = [meta(ROOT_ID,{parentId:'older-root-private'}),context('gpt-parent','inherited-turn-private'),
    tokens(beforeToday,[100,80,10])];
  const copied = [meta('child-full-copy-private'),meta(ROOT_ID),
    context('gpt-parent','inherited-turn-private'),tokens(firstToday,[100,80,10]),
    context('gpt-child','own-turn-private'),tokens(secondToday,[160,100,20],[60,20,10])];
  const {report,diagnostics}=await collect(t,{'parent.jsonl':parent,'child.jsonl':copied},{days:2});
  assert.equal(codexTotal(report).total_tokens,180);
  assert.equal(report.daily.find(r=>r.tool==='Codex'&&r.date==='2026-10-23').total_tokens,110);
  assert.equal(report.daily.find(r=>r.tool==='Codex'&&r.date==='2026-10-24').total_tokens,70);
  const oneDay=await collect(t,{'parent.jsonl':parent,'child.jsonl':copied});
  assert.equal(codexTotal(oneDay.report).total_tokens,70);
  assertOnlyMissingClaude(diagnostics);reconcile(report);
});
test('后续复制meta不能覆盖首meta中的模型回退',async t=>{
  const first=meta('child-model-private');first.payload.model='gpt-own';
  const history=meta(ROOT_ID);history.payload.model='gpt-parent';
  const {report,diagnostics}=await collect(t,{'child.jsonl':[first,history,tokens(firstToday,[20,5,2])]});
  assert.equal(report.by_model_daily.find(r=>r.model==='gpt-own').total_tokens,22);
  assert.equal(report.by_model_daily.some(r=>r.model==='gpt-parent'),false);
  assertOnlyMissingClaude(diagnostics);
});
test('无父子来源可证的相同turn身份明确报冲突，不任意选一个线程',async t=>{
  const a=[meta('independent-a',{parentId:null}),context('gpt-a','colliding-turn'),tokens(firstToday,[20,5,2])];
  const b=[meta('independent-b',{parentId:null}),context('gpt-b','colliding-turn'),tokens(secondToday,[30,5,2])];
  const {diagnostics}=await collect(t,{'a.jsonl':a,'b.jsonl':b});
  assert.equal(diagnostics['Codex｜用量来源冲突'],1);
});

test('fork历史的片段副本缺少上下文时，可由同线程同一事件补身份而不重复计祖先',async t=>{
  const parent=[meta(ROOT_ID,{parentId:'older-root-private'}),context('gpt-parent','parent-copy-turn'),tokens(beforeToday,[100,80,10])];
  const full=[meta('child-with-fragment'),meta(ROOT_ID),context('gpt-parent','parent-copy-turn'),tokens(firstToday,[100,80,10]),
    context('gpt-child','child-own-turn'),tokens(secondToday,[160,100,20],[60,20,10])];
  const fragment=full.filter(r=>r.type!=='turn_context');
  const result=await collect(t,{'00-child-fragment.jsonl':fragment,'10-child-full.jsonl':full,'parent.jsonl':parent},{days:2});
  assert.equal(codexTotal(result.report).total_tokens,180);
  assertOnlyMissingClaude(result.diagnostics);reconcile(result.report);
});

test('父来源缺失时以 started_at 识别重写时钟的继承用量，仅留基线并提示待核', async t => {
  const first = meta('child-missing-parent-original-time-private');
  first.payload.timestamp = firstToday;
  const oldTurn = 'missing-parent-old-turn-private';
  const newTurn = 'missing-parent-new-turn-private';
  const oldStarted = started(oldTurn, '2026-10-23T15:59:58Z');
  oldStarted.timestamp = secondToday;
  const records = [first, meta(ROOT_ID), oldStarted, context('gpt-inherited', oldTurn),
    tokens('2026-10-23T16:00:02Z', [100, 80, 10]),
    started(newTurn, '2026-10-23T16:01:00Z'), context('gpt-own', newTurn),
    tokens('2026-10-23T16:01:01Z', [160, 100, 20], [60, 20, 10])];
  const { report, diagnostics } = await collect(t, { 'child.jsonl': records });
  assert.deepEqual(codexTotal(report), { tool: 'Codex', ...normalized(60, 20, 10) });
  assert.equal(codexTotal(report).total_tokens, 70);
  assert.equal(report.by_model_daily.some(row => row.model === 'gpt-inherited'), false);
  assert.deepEqual(diagnostics, { 'Claude Code｜没有日志文件': 1, 'Codex｜继承用量来源待核': 1 });
  reconcile(report);
});

test('父日志已有对应旧 turn 时按原日归父，孩子只计新增且不报继承来源待核', async t => {
  const first = meta('child-known-parent-original-time-private');
  first.payload.timestamp = firstToday;
  const oldTurn = 'known-parent-old-turn-private';
  const newTurn = 'known-parent-new-turn-private';
  const parentMeta = meta(ROOT_ID, { parentId: 'older-root-private' });
  parentMeta.payload.timestamp = '2026-10-23T14:00:00Z';
  const parent = [parentMeta, started(oldTurn, '2026-10-23T15:59:58Z'),
    context('gpt-parent', oldTurn), tokens(beforeToday, [100, 80, 10])];
  const oldStarted = started(oldTurn, '2026-10-23T15:59:58Z');
  oldStarted.timestamp = secondToday;
  const childRecords = [first, meta(ROOT_ID), oldStarted, context('gpt-parent', oldTurn),
    tokens('2026-10-23T16:00:02Z', [100, 80, 10]),
    started(newTurn, '2026-10-23T16:01:00Z'), context('gpt-own', newTurn),
    tokens('2026-10-23T16:01:01Z', [160, 100, 20], [60, 20, 10])];
  const { report, diagnostics } = await collect(t, {
    'parent.jsonl': parent, 'child.jsonl': childRecords,
  }, { days: 2 });
  assert.deepEqual(codexTotal(report), { tool: 'Codex', ...normalized(160, 100, 20) });
  assert.equal(codexTotal(report).total_tokens, 180);
  assert.equal(report.daily.find(row => row.tool === 'Codex' && row.date === '2026-10-23').total_tokens, 110);
  assert.equal(report.daily.find(row => row.tool === 'Codex' && row.date === '2026-10-24').total_tokens, 70);
  assertOnlyMissingClaude(diagnostics);
  reconcile(report);
});

test('缺少 payload.started_at 时不以外层 timestamp 或父 meta 单独推断继承用量', async t => {
  const first = meta('child-unknown-original-time-private');
  first.payload.timestamp = firstToday;
  const oldTurn = 'unknown-original-time-old-turn-private';
  const newTurn = 'unknown-original-time-new-turn-private';
  const onlyOuterTime = { type: 'event_msg', timestamp: '2026-10-23T15:59:58Z',
    payload: { type: 'task_started', turn_id: oldTurn } };
  const records = [first, meta(ROOT_ID), onlyOuterTime, context('gpt-undetermined', oldTurn),
    tokens('2026-10-23T16:00:02Z', [100, 80, 10]),
    started(newTurn, '2026-10-23T16:01:00Z'), context('gpt-own', newTurn),
    tokens('2026-10-23T16:01:01Z', [160, 100, 20], [60, 20, 10])];
  const { report, diagnostics } = await collect(t, { 'child.jsonl': records });
  assert.deepEqual(codexTotal(report), { tool: 'Codex', ...normalized(160, 100, 20) });
  assert.equal(codexTotal(report).total_tokens, 180, '没有原始开始时间证据时不能静默扣掉110');
  assertOnlyMissingClaude(diagnostics);
  reconcile(report);
});
