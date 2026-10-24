import https from 'node:https';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { lstat, readFile } from 'node:fs/promises';
import { validateSubmission } from './local-store.mjs';
import { FIELDS, sumUsage } from './week.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONFIG_DIR = path.join(PROJECT_ROOT, '.runtime');
export const DEFAULT_PUBLIC_CONFIG_PATH = path.join(CONFIG_DIR, 'public-client.json');
const CONFIG_KEYS = ['endpoint', 'expected_host', 'source_id', 'token'];
const RECEIPT_KEYS = ['ok', 'changed', 'total_tokens', 'week_start', 'row_count', 'received_at'];
const fail = message => { throw new Error(message); };
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;

export function validatePublicClient(config) {
  if (!exactKeys(config, CONFIG_KEYS) || !validKey(config.source_id) || !validKey(config.token)) {
    fail('公开上报配置字段或专用密钥无效。');
  }
  const host = config.expected_host;
  if (typeof host !== 'string' || host.length > 253 || host !== host.toLowerCase() ||
      isIP(host) || !host.includes('.') || host.endsWith('.') ||
      /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host) ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    fail('公开上报需要明确的 HTTPS 域名。');
  }
  if (typeof config.endpoint !== 'string' || !config.endpoint.startsWith('https://') || /[\s\\%?#]/.test(config.endpoint)) fail('公开上报地址无效。');
  let endpoint;
  try { endpoint = new URL(config.endpoint); } catch { fail('公开上报地址无效。'); }
  const rawPath = config.endpoint.match(/^https:\/\/[^/]+(\/.*)?$/)?.[1] ?? '';
  const segments = rawPath.split('/').filter(Boolean);
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== host || endpoint.username || endpoint.password ||
      endpoint.port || endpoint.search || endpoint.hash || rawPath.includes('//') ||
      segments.some(segment => !/^[A-Za-z0-9._-]+$/.test(segment) || ['.', '..'].includes(segment))) {
    fail('公开上报地址必须与批准域名完全一致，并保留独立路径。');
  }
  const prefix = endpoint.pathname.replace(/\/$/, '');
  return Object.freeze({ endpoint: endpoint.origin + prefix, expected_host: host,
    source_id: config.source_id, token: config.token });
}
export async function loadPublicClient(configPath = DEFAULT_PUBLIC_CONFIG_PATH,
    { read = readFile, stat = lstat } = {}) {
  if (typeof configPath !== 'string') fail('公开上报配置位置无效。');
  const filename = path.resolve(configPath);
  if (path.dirname(filename) !== CONFIG_DIR ||
      !/^public-client(?:-[A-Za-z0-9_-]+)?\.json$/.test(path.basename(filename))) {
    fail('只允许读取本工程运行目录内的公开上报专用配置。');
  }
  let config;
  try {
    const directory = await stat(CONFIG_DIR), file = await stat(filename);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() ||
        file.size > 16384) throw new Error();
    config = JSON.parse(await read(filename, 'utf8'));
  } catch { fail('公开上报专用配置无法读取，请先完成独立环境配置。'); }
  return validatePublicClient(config);
}
export function buildPublicPayload(preview, config) {
  const client = validatePublicClient(config);
  try {
    if (!preview.diagnostics || typeof preview.diagnostics !== 'object' || Array.isArray(preview.diagnostics)) throw new Error();
    const rows = preview.rows.map(row => Object.fromEntries(
      ['date', 'tool', 'model', ...FIELDS].map(key => [key, row[key]])));
    const payload = { schema_version: 1, source_id: client.source_id, week_start: preview.week.start,
      collected_at: preview.collected_at, rows, diagnostics: { ...preview.diagnostics } };
    validateSubmission(payload, client.source_id);
    if (preview.schema_version !== 1 || preview.totals.total_tokens !== sumUsage(rows).total_tokens) throw new Error();
    return payload;
  } catch { fail('汇总数据无效或与预览总数不一致，已停止公开上报。'); }
}
function validateReceipt(value, preview) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true ||
      typeof value.changed !== 'boolean' || value.total_tokens !== preview.totals.total_tokens ||
      value.week_start !== preview.week.start || value.row_count !== preview.rows.length ||
      typeof value.received_at !== 'string' || !Number.isFinite(Date.parse(value.received_at)) ||
      new Date(value.received_at).toISOString() !== value.received_at) {
    fail('公开上报收据与预览不一致，请核对榜单。');
  }
  return Object.fromEntries(RECEIPT_KEYS.map(key => [key, value[key]]));
}
export async function sendPublicPreview(preview, config,
    { allowIncomplete = false, request = https.request, timeoutMs = 10000 } = {}) {
  const client = validatePublicClient(config);
  const payload = buildPublicPayload(preview, client);
  if (Object.keys(payload.diagnostics).length && !allowIncomplete) {
    fail('有日志未计入。先核对预览；接受不完整统计时才加 --allow-incomplete。');
  }
  const body = Buffer.from(JSON.stringify(payload));
  if (body.length > 1024 * 1024) fail('汇总数据过大，已停止公开上报。');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('上报超时设置无效。');
  const target = new URL(client.endpoint + '/api/usage');
  // 独立 Agent 不继承全局 Agent；proxyEnv 空对象明确禁用环境代理，旧 Node 忽略此选项。
  const agent = new https.Agent({ keepAlive: false, rejectUnauthorized: true, minVersion: 'TLSv1.2', proxyEnv: {} });
  return new Promise((resolve, reject) => {
    let settled = false, req, timer;
    const finish = (error, receipt) => {
      if (settled) return;
      settled = true; clearTimeout(timer); agent.destroy();
      if (error) reject(error); else resolve(receipt);
    };
    const stop = message => finish(new Error(message));
    timer = setTimeout(() => { stop('公开上报超时，请核对网络后重试。'); req?.destroy(); }, timeoutMs);
    timer.unref?.();
    try {
      req = request(target, {
        method: 'POST', agent, rejectUnauthorized: true, minVersion: 'TLSv1.2',
        checkServerIdentity: tls.checkServerIdentity, servername: client.expected_host,
        headers: { Authorization: 'Bearer ' + client.token, 'Content-Type': 'application/json',
          'Content-Length': body.length }, timeout: timeoutMs,
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          stop('公开上报不跟随重定向，请核对已批准的地址。'); res.destroy(); return;
        }
        if (res.statusCode !== 200) {
          const status = Number.isInteger(res.statusCode) ? res.statusCode : 0;
          const hints = { 401: '专用密钥无效或已撤销。', 409: '这份预览已过时，请重新采集。',
            413: '汇总数据过大。', 429: '请求过于频繁，请稍后重试。', 503: '独立服务暂不可用。' };
          stop('公开上报失败（HTTP ' + status + '）。' + (hints[status] ?? '')); res.destroy(); return;
        }
        let bytes = 0; const chunks = [];
        res.on('data', chunk => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > 65536) { stop('公开上报回复过大。'); res.destroy(); }
          else chunks.push(Buffer.from(chunk));
        });
        res.on('error', () => stop('公开上报回复中断，请重新核对榜单。'));
        res.on('end', () => {
          if (settled) return;
          try { finish(null, validateReceipt(JSON.parse(Buffer.concat(chunks).toString('utf8')), preview)); }
          catch { stop('公开上报收据与预览不一致，请核对榜单。'); }
        });
        res.on('aborted', () => stop('公开上报回复中断，请重新核对榜单。'));
      });
      req.on('timeout', () => { stop('公开上报超时，请核对网络后重试。'); req.destroy(); });
      req.on('error', () => stop('无法建立受信任的 HTTPS 上报连接，请核对网络与证书。'));
      req.end(body);
    } catch { stop('无法建立受信任的 HTTPS 上报连接，请核对网络与证书。'); req?.destroy(); }
  });
}
