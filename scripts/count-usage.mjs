#!/usr/bin/env node
// 只读取用量字段，不联网、不写文件，也不访问消息正文。
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const TOOLS = ['Claude Code', 'Codex'];
const FIELDS = ['input_tokens', 'output_tokens',
  'cache_creation_input_tokens', 'cache_read_input_tokens'];
const DAY_MS = 86_400_000;
const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

function beijingDate(date) {
  const parts = Object.fromEntries(DATE_FORMAT.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function parseArgs(args) {
  let days = 7;
  let json = false;
  let seenDays = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) {
      json = true;
    } else if (args[i] === '--days' && !seenDays && /^[1-9]\d*$/.test(args[i + 1] ?? '')) {
      days = Number(args[++i]);
      seenDays = true;
      if (!Number.isSafeInteger(days)) throw new Error('天数必须是正整数。');
    } else {
      throw new Error('参数错误。用法：node scripts/count-usage.mjs [--days 7] [--json]');
    }
  }
  return { days, json };
}

async function listJsonl(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('无法读取日志目录；请检查本机文件权限。');
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listJsonl(filename));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(filename);
    // 不跟随符号链接、快捷方式或目录联接，避免越出日志目录。
  }
  return files;
}

function warn(diagnostics, tool, kind) {
  const key = `${tool}｜${kind}`;
  diagnostics[key] = (diagnostics[key] ?? 0) + 1;
}

async function* readRecords(filename, tool, diagnostics, includeModels = false) {
  const stream = createReadStream(filename, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      // 仅解析可能含用量或会话编号的行，不读取 content、text、工具参数等字段。
      const relevant = tool === 'Claude Code'
        ? /"type"\s*:\s*"assistant"/.test(line) && /"usage"\s*:/.test(line)
        : /"type"\s*:\s*"(token_count|session_meta|turn_context|task_started|turn_started)"/.test(line);
      if (!relevant) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // 正在写入的日志可能留下不完整尾行；只报告数量，不打印原文或异常栈。
        warn(diagnostics, tool, '无法解析的记录');
      }
    }
  } catch {
    throw new Error('读取日志失败；请检查本机文件权限。');
  } finally {
    lines.close();
    stream.destroy();
  }
}

function modelIdentifier(value) {
  // 只保留有限的模型标识字符；路径、空格、控制字符和非 ASCII 内容不外传。
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value : 'unknown';
}

function tokenNumber(value, optional = false) {
  if (value == null && optional) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('无效计数');
  return value;
}

function claudeUsage(usage) {
  return {
    input_tokens: tokenNumber(usage.input_tokens),
    output_tokens: tokenNumber(usage.output_tokens),
    cache_creation_input_tokens: tokenNumber(usage.cache_creation_input_tokens, true),
    cache_read_input_tokens: tokenNumber(usage.cache_read_input_tokens, true),
  };
}

function codexUsage(usage) {
  const numbers = {
    input_tokens: tokenNumber(usage.input_tokens),
    output_tokens: tokenNumber(usage.output_tokens),
    cache_creation_input_tokens: tokenNumber(usage.cache_write_input_tokens, true),
    cache_read_input_tokens: tokenNumber(usage.cached_input_tokens, true),
  };
  if (numbers.input_tokens < numbers.cache_creation_input_tokens + numbers.cache_read_input_tokens) {
    throw new Error('缓存计数超过输入');
  }
  return numbers;
}

function normalizeCodex(usage) {
  // Codex input_tokens 已包含缓存；转成与 Claude 四列互斥的口径。
  return {
    ...usage,
    input_tokens: usage.input_tokens - usage.cache_creation_input_tokens - usage.cache_read_input_tokens,
  };
}

function tokenTotal(usage) {
  return FIELDS.reduce((sum, field) => sum + usage[field], 0);
}

function emptyUsage() {
  return Object.fromEntries(FIELDS.map(field => [field, 0]));
}

function finishRow(row) {
  const total = tokenTotal(row);
  return { ...row, total_tokens: total,
    total_without_cache_read_tokens: total - row.cache_read_input_tokens };
}

export async function collectUsage({
  home = os.homedir(), days = 7, now = new Date(),
  claudeRoot = path.join(home, '.claude', 'projects'),
  codexRoot = path.join(home, '.codex', 'sessions'),
  includeModels = false,
} = {}) {
  if (!Number.isSafeInteger(days) || days < 1 || !Number.isFinite(now.getTime())) {
    throw new Error('日期或天数无效。');
  }
  const todayStart = Date.parse(`${beijingDate(now)}T00:00:00+08:00`);
  const start = todayStart - (days - 1) * DAY_MS;
  if (!Number.isFinite(new Date(start).getTime())) throw new Error('天数超出日期范围。');
  const diagnostics = {};
  const rows = new Map();
  const modelRows = new Map();
  for (let i = 0; i < days; i++) {
    const date = beijingDate(new Date(start + i * DAY_MS));
    for (const tool of TOOLS) rows.set(`${date}|${tool}`, { date, tool, ...emptyUsage() });
  }
  function add(timestamp, tool, usage, model = 'unknown') {
    if (timestamp < start || timestamp > now.getTime()) return;
    const row = rows.get(`${beijingDate(new Date(timestamp))}|${tool}`);
    if (!row) return;
    for (const field of FIELDS) {
      if (!Number.isSafeInteger(usage[field]) || usage[field] < 0 ||
          !Number.isSafeInteger(row[field] + usage[field])) throw new Error('计数超出安全范围。');
      row[field] += usage[field];
    }
    if (includeModels) {
      const key = `${row.date}|${tool}|${model}`;
      if (!modelRows.has(key)) modelRows.set(key, { date: row.date, tool, model, ...emptyUsage() });
      const modelRow = modelRows.get(key);
      for (const field of FIELDS) modelRow[field] += usage[field];
    }
  }

  const messages = new Map();
  const claudeFiles = await listJsonl(claudeRoot);
  if (claudeFiles.length === 0) warn(diagnostics, TOOLS[0], '没有日志文件');
  for (const filename of claudeFiles) {
    for await (const record of readRecords(filename, TOOLS[0], diagnostics)) {
      if (record.type !== 'assistant' || !record.message?.usage) continue;
      const id = record.message.id;
      const timestamp = Date.parse(record.timestamp);
      if (typeof id !== 'string' || !id || !Number.isFinite(timestamp)) {
        warn(diagnostics, TOOLS[0], '缺少消息编号或日期'); continue;
      }
      if (timestamp > now.getTime()) continue;
      let usage;
      try { usage = claudeUsage(record.message.usage); }
      catch { warn(diagnostics, TOOLS[0], '无效用量记录'); continue; }
      const old = messages.get(id);
      // 全目录按 message.id 去重。模型跟随较大的完整计数，日期仍取首次记录。
      const useOld = old && tokenTotal(old.usage) > tokenTotal(usage);
      messages.set(id, {
        timestamp: Math.min(timestamp, old?.timestamp ?? timestamp),
        usage: useOld ? old.usage : usage,
        model: useOld ? old.model : modelIdentifier(record.message.model),
      });
    }
  }
  for (const message of messages.values()) {
    add(message.timestamp, TOOLS[0], message.usage, message.model);
  }

  const sessions = new Map();
  const sessionParents = new Map();
  const codexFiles = await listJsonl(codexRoot);
  if (codexFiles.length === 0) warn(diagnostics, TOOLS[1], '没有日志文件');
  for (const filename of codexFiles) {
    let sessionId = filename;
    let seenSessionMeta = false;
    let currentModel = 'unknown';
    let currentTurn = null;
    let sessionCreated = NaN;
    let hasParent = false;
    const turnStarts = new Map();
    for await (const record of readRecords(filename, TOOLS[1], diagnostics, includeModels)) {
      if (record.type === 'session_meta') {
        // 首个meta属于此物理日志；后续meta可能只是父线程复制的历史，绝不能改写当前线程。
        if (!seenSessionMeta) {
          seenSessionMeta = true;
          const id = record.payload?.id ?? record.payload?.session_id;
          if (typeof id === 'string' && id) sessionId = id;
          currentModel = modelIdentifier(record.payload?.model);
          sessionCreated = Date.parse(record.payload?.timestamp);
          const parents = [record.payload?.parent_thread_id, record.payload?.forked_from_id]
            .filter(parent => typeof parent === 'string' && parent && parent !== sessionId);
          hasParent = parents.length > 0;
          if (!sessionParents.has(sessionId)) sessionParents.set(sessionId, new Set());
          for (const parent of parents) sessionParents.get(sessionId).add(parent);
        }
        continue;
      }
      if (record.type === 'turn_context') {
        currentModel = modelIdentifier(record.payload?.model);
        currentTurn = typeof record.payload?.turn_id === 'string' ? record.payload.turn_id : null;
        continue;
      }
      if (record.type === 'event_msg' && ['task_started', 'turn_started'].includes(record.payload?.type)) {
        if (typeof record.payload.turn_id === 'string' && record.payload.turn_id) {
          currentTurn = record.payload.turn_id;
          turnStarts.set(currentTurn, Date.parse(record.payload.started_at));
        }
        continue;
      }
      if (record.type !== 'event_msg' || record.payload?.type !== 'token_count') continue;
      const info = record.payload.info;
      if (info == null) continue; // 只有额度信息的事件没有用量，不计入。
      const timestamp = Date.parse(record.timestamp);
      if (!Number.isFinite(timestamp)) {
        warn(diagnostics, TOOLS[1], '缺少日期'); continue;
      }
      if (timestamp > now.getTime()) continue;
      let total, last;
      try {
        total = codexUsage(info.total_token_usage);
        last = info.last_token_usage ? codexUsage(info.last_token_usage) : null;
      } catch { warn(diagnostics, TOOLS[1], '无效用量记录'); continue; }
      if (!sessions.has(sessionId)) sessions.set(sessionId, []);
      const turnStarted = turnStarts.get(currentTurn);
      const possiblyInherited = hasParent && Number.isFinite(sessionCreated) &&
        Number.isFinite(turnStarted) && turnStarted < sessionCreated;
      sessions.get(sessionId).push({ timestamp, total, last, model: currentModel,
        turn: currentTurn, possiblyInherited });
    }
  }
  // fork若真的复制token历史，其turn_id仍指向祖先。只在明确的父子关系下识别原拥有者，
  // 不按“数字相同”跨独立线程去重，也不把重写后的复制时间当消费发生时间。
  // 同线程相同时间/累计/last的片段副本可补turn身份，不能让缺上下文的副本抢先计祖先。
  const eventIdentity = event => `${event.timestamp}|${FIELDS.map(k => event.total[k]).join('|')}|${event.last ? FIELDS.map(k => event.last[k]).join('|') : 'none'}`;
  for (const events of sessions.values()) {
    const knownTurns = new Map();
    for (const event of events) if (event.turn) {
      const key = eventIdentity(event);
      if (!knownTurns.has(key)) knownTurns.set(key, new Set());
      knownTurns.get(key).add(event.turn);
    }
    for (const event of events) if (!event.turn) {
      const turns = knownTurns.get(eventIdentity(event));
      if (turns?.size === 1) event.turn = [...turns][0];
    }
  }
  const turnSessions = new Map();
  for (const [id, events] of sessions) for (const event of events) if (event.turn) {
    if (!turnSessions.has(event.turn)) turnSessions.set(event.turn, new Set());
    turnSessions.get(event.turn).add(id);
  }
  function descendsFrom(id, ancestor, visited = new Set()) {
    if (id === ancestor) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return [...(sessionParents.get(id) ?? [])].some(parent => descendsFrom(parent, ancestor, visited));
  }
  const turnOwners = new Map();
  for (const [turn, ids] of turnSessions) {
    const owners = [...ids].filter(candidate => [...ids].every(id => descendsFrom(id, candidate)));
    // 原父日志缺失时，复制历史也可能只出现于孩子。只用内嵌开始时间标可疑，
    // 不能用会被重写的外层时间认定孩子是新消费来源。保留基线并显式诊断。
    const sourceUncertain = owners.length === 1 && sessions.get(owners[0]).some(
      event => event.turn === turn && event.possiblyInherited);
    turnOwners.set(turn, owners.length === 1 && !sourceUncertain ? owners[0] : null);
    if (owners.length !== 1) warn(diagnostics, TOOLS[1], '用量来源冲突');
    else if (sourceUncertain) warn(diagnostics, TOOLS[1], '继承用量来源待核');
  }
  for (const [sessionId, events] of sessions) {
    events.sort((a, b) => a.timestamp - b.timestamp);
    if (includeModels) {
      // 相同事件的另一份副本可能保留了模型上下文，只补模型，不改变累计差分顺序。
      const eventKey = eventIdentity;
      const knownModels = new Map();
      for (const event of events) {
        if (event.model !== 'unknown' && !knownModels.has(eventKey(event))) {
          knownModels.set(eventKey(event), event.model);
        }
      }
      for (const event of events) {
        if (event.model === 'unknown') event.model = knownModels.get(eventKey(event)) ?? 'unknown';
      }
    }
    let previous = null;
    for (const event of events) {
      if (previous && FIELDS.every(field => event.total[field] === previous[field])) continue;
      let usage;
      if (previous && FIELDS.every(field => event.total[field] >= previous[field])) {
        usage = Object.fromEntries(FIELDS.map(field => [field, event.total[field] - previous[field]]));
      } else {
        // 首条可能继承了旧会话累计数；重置时也只计本次，避免历史全算到今天。
        usage = event.last;
      }
      previous = event.total; // 即使在窗口前，也要保留累计基线。
      if (!usage) { warn(diagnostics, TOOLS[1], '缺少单次用量基线'); continue; }
      try {
        const normalized = normalizeCodex(usage);
        if (normalized.input_tokens < 0) throw new Error('无效差值');
        // 继承快照仍用来建立孩子的累计基线，但它本身只能在原拥有者处计一次。
        if (event.turn && turnOwners.get(event.turn) !== sessionId) continue;
        add(event.timestamp, TOOLS[1], normalized, event.model);
      } catch { warn(diagnostics, TOOLS[1], '无效用量差值'); }
    }
  }

  const daily = [...rows.values()].map(finishRow);
  const totals = TOOLS.map(tool => {
    const summary = { tool, ...emptyUsage() };
    for (const row of daily.filter(row => row.tool === tool)) {
      for (const field of FIELDS) summary[field] += row[field];
    }
    return finishRow(summary);
  });
  const all = { tool: '合计', ...emptyUsage() };
  for (const row of totals) for (const field of FIELDS) all[field] += row[field];
  totals.push(finishRow(all));
  if ([...daily, ...totals].some(row =>
    [...FIELDS, 'total_tokens', 'total_without_cache_read_tokens'].some(field =>
      !Number.isSafeInteger(row[field])))) throw new Error('合计超出安全整数范围。');
  const report = { daily, totals };
  if (includeModels) {
    report.by_model_daily = [...modelRows.values()]
      .sort((a, b) => a.date.localeCompare(b.date) || TOOLS.indexOf(a.tool) - TOOLS.indexOf(b.tool)
        || a.model.localeCompare(b.model))
      .map(finishRow);
    if (report.by_model_daily.some(row =>
      [...FIELDS, 'total_tokens', 'total_without_cache_read_tokens'].some(field =>
        !Number.isSafeInteger(row[field])))) throw new Error('模型合计超出安全整数范围。');
  }
  return { report, diagnostics };
}

export function formatTable(report) {
  const headers = ['日期', '工具', '输入', '输出', '缓存写入', '缓存读取', '合计', '不含缓存读取'];
  const number = value => value.toLocaleString('en-US');
  const values = [...report.daily, ...report.totals].map(row => [
    row.date ?? '合计', row.tool, ...FIELDS.map(field => number(row[field])),
    number(row.total_tokens), number(row.total_without_cache_read_tokens),
  ]);
  const width = value => [...value].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  const widths = headers.map((header, i) => Math.max(width(header), ...values.map(row => width(row[i]))));
  const line = row => row.map((value, i) => i < 2
    ? value + ' '.repeat(widths[i] - width(value))
    : ' '.repeat(widths[i] - width(value)) + value).join('  ');
  return [line(headers), ...values.map(line)].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { report, diagnostics } = await collectUsage(options);
  for (const [kind, count] of Object.entries(diagnostics)) {
    console.error(`${kind}：${count}`);
  }
  console.log(options.json ? JSON.stringify(report, null, 2) : formatTable(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
