import { mkdir, lstat, readFile, open, rename, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { FIELDS, TOOLS, validDate, weekFor, beijingDate, finishUsage, sumUsage } from './week.mjs';
import { estimateUsage, PRICING_CHECKED_AT } from './pricing.mjs';

export const DEFAULT_DATA_DIR = process.env.YAK_YOGURT_DATA_DIR ? path.resolve(process.env.YAK_YOGURT_DATA_DIR) : fileURLToPath(new URL('../.runtime/', import.meta.url));
export const DEFAULT_PROFILE = Object.freeze({ nickname: '甲和鸟', city: '拉萨',
  project_name: '有酸奶 Yak Yogurt', project_description: '认识在西藏使用 AI 创作与编程的同行',
  project_url: 'https://github.com/lanjiashen/yak-yogurt' });
export class LocalError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = message => { throw new LocalError(message); };
const exactKeys = (object, keys) => object && !Array.isArray(object) && typeof object === 'object' &&
  Object.keys(object).length === keys.length && Object.keys(object).every(k => keys.includes(k));
export const tokenHash = token => createHash('sha256').update(token).digest('hex');

export async function readJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new LocalError('本机数据无法读取，请保留文件并检查备份。', 500); }
}
export async function atomicJson(filename, object, backup = false) {
  const temp = filename + '.tmp-' + randomUUID();
  const fd = await open(temp, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(object, null, 2) + '\n', 'utf8'); await fd.sync(); }
  finally { await fd.close(); }
  if (backup) {
    try { await copyFile(filename, filename + '.bak'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await rename(temp, filename);
}
async function withDirectoryLock(dataDir, operation) {
  const filename = path.join(dataDir, '.write.lock');
  const deadline = Date.now() + 4000;
  let fd;
  while (!fd) {
    try { fd = await open(filename, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new LocalError('另一个本机操作正在写入；若上次异常退出，请先保留数据检查写入锁，不会自动清空。', 409);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { await fd.writeFile(JSON.stringify({ pid:process.pid, created_at:new Date().toISOString() })); return await operation(); }
  finally { await fd.close(); await unlink(filename); }
}
async function createJson(filename, object) {
  try {
    const fd = await open(filename, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(object, null, 2) + '\n', 'utf8'); await fd.sync(); }
    finally { await fd.close(); }
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
}
export function validateEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new LocalError('上报地址无效。'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new LocalError('本阶段只允许向127.0.0.1本机服务上报。');
  }
  return url.origin;
}
export function validateProfile(profile) {
  if (!exactKeys(profile, Object.keys(DEFAULT_PROFILE))) fail('资料字段无效。');
  const limits = { nickname: 40, city: 30, project_name: 80, project_description: 240, project_url: 500 };
  for (const [field, max] of Object.entries(limits)) {
    if (typeof profile[field] !== 'string' || profile[field].length > max || /[\u0000-\u001f]/.test(profile[field])) fail('资料格式或长度无效。');
  }
  if (!profile.nickname.trim() || !profile.city.trim()) fail('昵称和城市不能为空。');
  if (profile.project_url) {
    let url; try { url = new URL(profile.project_url); } catch { fail('作品链接无效。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('作品链接仅支持普通网页地址。');
  }
  return Object.fromEntries(Object.entries(profile).map(([k,v]) => [k, v.trim()]));
}
const DIAGNOSTICS = new Set(['没有日志文件','无法解析的记录','缺少消息编号或日期','无效用量记录','缺少日期','缺少单次用量基线','无效用量差值','用量来源冲突','继承用量来源待核']);
export function validateSubmission(payload, sourceId, now = new Date()) {
  if (!exactKeys(payload, ['schema_version','source_id','week_start','collected_at','rows','diagnostics'])) fail('上报只接受规定的汇总字段。');
  if (payload.schema_version !== 1 || payload.source_id !== sourceId) fail('当前密钥仅支持已登记的这一台电脑。');
  if (!validDate(payload.week_start) || weekFor(payload.week_start).start !== payload.week_start) fail('周榜必须从北京时间周一开始。');
  const stamp = Date.parse(payload.collected_at);
  if (typeof payload.collected_at !== 'string' || !Number.isFinite(stamp) || new Date(stamp).toISOString() !== payload.collected_at ||
      stamp > now.getTime() + 60000 || weekFor(new Date(stamp)).start !== payload.week_start) fail('采集日期与自然周不一致。');
  if (!Array.isArray(payload.rows) || payload.rows.length > 5000) fail('上报行数无效。');
  const dates = new Set(), today = beijingDate(new Date(stamp));
  const rows = payload.rows.map(row => {
    if (!exactKeys(row, ['date','tool','model',...FIELDS])) fail('只允许日期、工具、模型和四类用量，不能提交原始日志。');
    if (!validDate(row.date) || row.date < payload.week_start || row.date > today || !TOOLS.includes(row.tool) ||
      typeof row.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.model)) fail('日期、工具或模型无效。');
    const key = [row.date,row.tool,row.model].join('|');
    if (dates.has(key)) fail('同日同工具同模型不可重复。');
    dates.add(key);
    for (const field of FIELDS) if (!Number.isSafeInteger(row[field]) || row[field] < 0) fail('用量必须为非负安全整数。');
    try { finishUsage(row); } catch { fail('用量合计超出范围。'); }
    return Object.fromEntries(['date','tool','model',...FIELDS].map(key => [key,row[key]]));
  }).sort((a,b) => [a.date,a.tool,a.model].join('|').localeCompare([b.date,b.tool,b.model].join('|')));
  try { sumUsage(rows); } catch { fail('总用量超出范围。'); }
  if (!payload.diagnostics || Array.isArray(payload.diagnostics) || typeof payload.diagnostics !== 'object' ||
      Object.keys(payload.diagnostics).length > 14) fail('诊断计数无效。');
  for (const [key,n] of Object.entries(payload.diagnostics)) {
    const [tool,kind,...extra] = key.split('｜');
    if (extra.length || !TOOLS.includes(tool) || !DIAGNOSTICS.has(kind) || !Number.isSafeInteger(n) || n < 1) fail('只接受固定类别的诊断数量。');
  }
  return { week_start: payload.week_start, collected_at: payload.collected_at, rows, diagnostics: { ...payload.diagnostics } };
}
export async function createRepository({ dataDir = DEFAULT_DATA_DIR, now = () => new Date() } = {}) {
  dataDir = path.resolve(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if ((await lstat(dataDir)).isSymbolicLink()) throw new LocalError('运行数据目录不能是符号链接。', 500);
  const files = Object.fromEntries(['data','auth','client'].map(name => [name,path.join(dataDir, name + '.json')]));
  await withDirectoryLock(dataDir, async () => {
  let auth;
  try { auth = JSON.parse(await readFile(files.auth, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw new LocalError('本机密钥文件无法读取，未自动覆盖。', 500);
    const token = randomBytes(32).toString('base64url');
    const source_id = randomUUID();
    auth = { source_id, token_hash: tokenHash(token), enabled: true };
    await createJson(files.auth, auth);
    await createJson(files.client, { endpoint: 'http://127.0.0.1:8796', source_id, token });
  }
  if (typeof auth.source_id !== 'string' || typeof auth.enabled !== 'boolean' ||
      !/^[a-f0-9]{64}$/.test(auth.token_hash)) throw new LocalError('本机密钥文件无效，未自动覆盖。', 500);
  await createJson(files.data, { schema_version: 1, profile: DEFAULT_PROFILE, weeks: {} });
  });
  let queue = Promise.resolve();
  const mutate = operation => {
    const next = queue.then(() => withDirectoryLock(dataDir, operation)); queue = next.catch(() => {}); return next;
  };
  const getData = async () => {
    const state = await readJson(files.data);
    if (state.schema_version !== 1 || !state.weeks || typeof state.weeks !== 'object' || Array.isArray(state.weeks)) throw new LocalError('本机数据版本无效。', 500);
    validateProfile(state.profile);
    return state;
  };
  const authenticate = async token => {
    const credentials = await readJson(files.auth);
    if (!credentials.enabled || typeof token !== 'string' || token.length > 256) return false;
    const a = Buffer.from(tokenHash(token)), b = Buffer.from(credentials.token_hash);
    return a.length === b.length && timingSafeEqual(a,b);
  };
  return {
    files, authenticate,
    setEndpoint: endpoint => mutate(async () => {
      const client = await readJson(files.client);
      await atomicJson(files.client,{ ...client, endpoint: validateEndpoint(endpoint) });
    }),
    submit: (payload, token) => mutate(async () => {
      if (!await authenticate(token)) throw new LocalError('上报密钥无效或已撤销。', 401);
      const credentials = await readJson(files.auth);
      const snapshot = validateSubmission(payload, credentials.source_id, now());
      const state = await getData(), old = state.weeks[snapshot.week_start];
      if (old && Date.parse(snapshot.collected_at) < Date.parse(old.collected_at)) throw new LocalError('这份预览比已保存的数据旧，请重新预览。', 409);
      const changed = !old || JSON.stringify([old.rows,old.diagnostics]) !== JSON.stringify([snapshot.rows,snapshot.diagnostics]);
      state.weeks[snapshot.week_start] = { ...snapshot, received_at: now().toISOString() };
      await atomicJson(files.data,state,true);
      return { ok: true, changed, total_tokens: sumUsage(snapshot.rows).total_tokens,
        week_start: snapshot.week_start, row_count: snapshot.rows.length, received_at: state.weeks[snapshot.week_start].received_at };
    }),
    leaderboard: async start => {
      if (start && !validDate(start)) fail('周榜日期无效。');
      const week = start ? weekFor(start) : weekFor(now());
      if (start && week.start !== start) fail('请选择周一日期。');
      const state = await getData(), snapshot = state.weeks[week.start];
      const daily = (snapshot?.rows ?? []).map(finishUsage);
      const totals = sumUsage(daily), estimate = estimateUsage(daily);
      const profile = validateProfile(state.profile);
      return { schema_version: 1, week: { ...week, is_current: week.start === weekFor(now()).start },
        profile, participant_count: snapshot ? 1 : 0, updated_at: snapshot?.received_at ?? null,
        rows: snapshot ? [{ rank: 1, ...profile, tools: TOOLS.filter(tool => daily.some(r => r.tool === tool && r.total_tokens > 0)),
          models: [...new Set(daily.filter(r => r.total_tokens > 0).map(r => r.model))].sort(), ...totals, estimate }] : [],
        daily, totals, estimate, pricing_checked_at: PRICING_CHECKED_AT, diagnostics: snapshot?.diagnostics ?? {} };
    },
    updateProfile: profile => mutate(async () => {
      const state = await getData(); state.profile = validateProfile(profile);
      await atomicJson(files.data,state,true); return state.profile;
    }),
    revokeKey: () => mutate(async () => {
      const credentials = await readJson(files.auth);
      await atomicJson(files.auth,{ ...credentials,enabled:false }); return { ok:true };
    }),
    rotateKey: () => mutate(async () => {
      const credentials = await readJson(files.auth), client = await readJson(files.client);
      const token = randomBytes(32).toString('base64url');
      await atomicJson(files.auth,{ ...credentials,token_hash:tokenHash(token),enabled:true });
      await atomicJson(files.client,{ ...client,token }); return { ok:true };
    }),
  };
}
