export const COUNT_FIELDS = Object.freeze(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']);
const TOTAL_FIELDS = [...COUNT_FIELDS, 'total_tokens', 'total_without_cache_read_tokens'];
const TOOL_ORDER = ['Claude Code', 'Codex'];

export function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function beijingDate(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('日期无效。');
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function addDays(date, count) {
  if (!isDate(date) || !Number.isInteger(count)) throw new Error('日期无效。');
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
export function weekStartForDate(date) {
  if (!isDate(date)) throw new Error('日期无效。');
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}
export function summarizeUsage(rows) {
  if (!Array.isArray(rows)) throw new Error('用量明细格式不完整。');
  const totals = Object.fromEntries(COUNT_FIELDS.map(function (field) { return [field, 0]; }));
  for (const row of rows) {
    for (const field of COUNT_FIELDS) {
      if (!Number.isSafeInteger(row?.[field]) || row[field] < 0) throw new Error('用量不是有效的非负整数。');
      totals[field] += row[field];
      if (!Number.isSafeInteger(totals[field])) throw new Error('用量超出安全计数范围。');
    }
  }
  totals.total_tokens = COUNT_FIELDS.reduce(function (sum, field) { return sum + totals[field]; }, 0);
  if (!Number.isSafeInteger(totals.total_tokens)) throw new Error('用量超出安全计数范围。');
  totals.total_without_cache_read_tokens = totals.total_tokens - totals.cache_read_input_tokens;
  return totals;
}
export function normalizeUsageRows(rows) {
  if (!Array.isArray(rows)) throw new Error('用量明细格式不完整。');
  const keys = new Set();
  return rows.map(function (row) {
    if (!isDate(row?.date) || typeof row.tool !== 'string' || !row.tool ||
        typeof row.model !== 'string' || !row.model) throw new Error('日期、工具或模型明细不完整。');
    const key = JSON.stringify([row.date, row.tool, row.model]);
    if (keys.has(key)) throw new Error('同日同工具同模型出现了重复记录。');
    keys.add(key);
    const totals = summarizeUsage([row]);
    if (row.total_tokens !== undefined && row.total_tokens !== totals.total_tokens) throw new Error('用量明细与四类计数不一致。');
    if (row.total_without_cache_read_tokens !== undefined &&
        row.total_without_cache_read_tokens !== totals.total_without_cache_read_tokens) throw new Error('用量明细与四类计数不一致。');
    return { date: row.date, tool: row.tool, model: row.model, ...totals };
  });
}
export function safeLink(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function dayBoardFromWeekly(data, date, { now = new Date() } = {}) {
  if (!isDate(date)) throw new Error('日期无效。');
  const start = weekStartForDate(date);
  if (!data || data.schema_version !== 1 || data.week?.start !== start ||
      data.week?.end !== addDays(start, 6) || !Array.isArray(data.rows) ||
      ![0, 1].includes(data.participant_count) || data.rows.length !== data.participant_count) {
    throw new Error('当前周榜格式无法核对所选日期，请重新读取。');
  }
  const weeklyRows = normalizeUsageRows(data.daily);
  if (weeklyRows.some(function (row) { return row.date < start || row.date > addDays(start, 6); }) ||
      (data.participant_count === 0 && weeklyRows.length)) throw new Error('用量日期与所在周不一致。');
  const dayRows = weeklyRows.filter(function (row) { return row.date === date; });
  const hasSnapshot = data.participant_count === 1;
  const hasDayRows = hasSnapshot && dayRows.length > 0;
  const totals = hasDayRows ? summarizeUsage(dayRows) : null;
  const status = !hasSnapshot ? 'no_snapshot' : !hasDayRows ? 'not_reported' :
    totals.total_tokens === 0 ? 'reported_zero' : 'reported';
  const source = { ...(data.profile || {}), ...(data.rows[0] || {}) };
  const profile = Object.fromEntries(['nickname', 'city', 'project_name', 'project_description', 'project_url']
    .map(function (key) { return [key, typeof source[key] === 'string' ? source[key] : '']; }));
  const tools = [...new Set(dayRows.filter(function (row) { return row.total_tokens > 0; })
    .map(function (row) { return row.tool; }))].sort(function (a, b) {
      const aa = TOOL_ORDER.indexOf(a), bb = TOOL_ORDER.indexOf(b);
      return (aa < 0 ? 99 : aa) - (bb < 0 ? 99 : bb) || a.localeCompare(b);
    });
  const today = beijingDate(now);
  return { date, week_start: start, status, has_snapshot: hasSnapshot, profile,
    day_rows: dayRows, weekly_rows: weeklyRows, totals, tools,
    rows: hasSnapshot ? [{ ...profile, rank: hasDayRows ? 1 : null, tools, status,
      total_tokens: totals ? totals.total_tokens : null }] : [],
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : null,
    is_today: date === today, is_future: date > today };
}


export const COMMUNITY_API_BASE = 'https://cloud1-d1gwtdw2y9153c1b3-1499259329.ap-shanghai.app.tcloudbase.com/yak-yogurt/';
export const PROFILE_FIELDS = Object.freeze(['nickname','city','project_name','project_description','project_url','avatar_ref','cover_ref']);
const canonicalKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
const isoDateTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function mediaReference(value, slot) {
  if (value === '') return '';
  const match = typeof value === 'string' ? /^m_[A-Za-z0-9_-]{43}_(avatar|cover)_[a-f0-9]{64}$/.exec(value) : null;
  if (!match || (slot && match[1] !== slot)) throw new Error('图片引用无效。');
  return value;
}
export function publicProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('公开资料格式不完整。');
  const result = {};
  const limits = { nickname:40,city:30,project_name:80,project_description:240,project_url:500,avatar_ref:160,cover_ref:160 };
  for (const key of PROFILE_FIELDS) {
    if (typeof value[key] !== 'string' || value[key].length > limits[key] || /[\u0000-\u001f]/.test(value[key])) throw new Error('公开资料格式或长度无效。');
    result[key] = value[key];
  }
  if (result.project_url && (!safeLink(result.project_url) || new URL(result.project_url).protocol !== 'https:')) throw new Error('作品链接请使用不含账号信息的 HTTPS 地址。');
  mediaReference(result.avatar_ref, 'avatar'); mediaReference(result.cover_ref, 'cover');
  return result;
}
function checkedTotals(value) {
  const totals = summarizeUsage([value]);
  for (const field of TOTAL_FIELDS) if (value?.[field] !== totals[field]) throw new Error('汇总与四类计数不一致。');
  return totals;
}
export function normalizeV2Board(value, date) {
  if (!isDate(date) || value?.schema_version !== 2 || value.date !== date || value.timezone !== 'Asia/Shanghai' ||
      !Array.isArray(value.rows) || !Number.isSafeInteger(value.participant_count) || value.participant_count < 0) throw new Error('日榜数据格式不完整。');
  const users = new Set();
  const rows = value.rows.map(function (row) {
    if ((!canonicalKey(row.user_id) && row.user_id !== 'legacy-owner') || users.has(row.user_id) ||
        !Number.isSafeInteger(row.rank) || row.rank < 1 || !Number.isSafeInteger(row.total_tokens) || row.total_tokens < 0 ||
        !Array.isArray(row.tools) || row.tools.some(tool => !TOOL_ORDER.includes(tool)) || new Set(row.tools).size !== row.tools.length) throw new Error('日榜创作者或用量记录无效。');
    users.add(row.user_id);
    return { ...publicProfile(row), user_id:row.user_id,rank:row.rank,tools:[...row.tools],
      total_tokens:row.total_tokens,status:row.total_tokens === 0 ? 'reported_zero' : 'reported' };
  });
  const totals = checkedTotals(value.totals);
  const rowSum = rows.reduce((sum,row) => sum + row.total_tokens,0);
  if (!Number.isSafeInteger(rowSum) || rowSum !== totals.total_tokens) throw new Error('日榜行与总量不一致。');
  return { date,rows,totals,participant_count:value.participant_count,updated_at:isoDateTime(value.updated_at) ? value.updated_at : null };
}
export function normalizeV2Detail(value, date, user = 'all') {
  if (value?.schema_version !== 2 || value.date !== date || !isDate(date) ||
      value.scope !== (user === 'all' ? 'all' : 'member') ||
      (user !== 'all' && value.user_id !== user)) throw new Error('用量范围与请求不一致。');
  const daily = normalizeUsageRows(value.daily);
  if (daily.some(row => row.date !== date)) throw new Error('单日明细包含其他日期。');
  const totals = checkedTotals(value.totals), sum = summarizeUsage(daily);
  if (TOTAL_FIELDS.some(field => totals[field] !== sum[field])) throw new Error('明细与汇总不一致。');
  return { ...value,daily,totals,profile:value.profile === null ? null : publicProfile(value.profile) };
}
export function sessionRecord(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !canonicalKey(value.session_token) ||
      !isoDateTime(value.expires_at) || Date.parse(value.expires_at) <= now.getTime()) return null;
  return { session_token:value.session_token,expires_at:value.expires_at };
}
export function generatedClientConfig(value) {
  const keys = ['api_version','endpoint','expected_host','source_id','token'];
  const expected = new URL(COMMUNITY_API_BASE);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      Object.keys(value).some(key => !keys.includes(key)) || value.api_version !== 2 ||
      value.endpoint !== COMMUNITY_API_BASE.replace(/\/$/,'') || value.expected_host !== expected.hostname ||
      !canonicalKey(value.source_id) || !canonicalKey(value.token)) throw new Error('专用配置格式无效，未提供下载。');
  return Object.fromEntries(keys.map(key => [key,value[key]]));
}
export function imageOutputSize(slot, width, height) {
  if (!['avatar','cover'].includes(slot) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width * height > 80000000) throw new Error('图片尺寸过大或无效。');
  if (slot === 'avatar') { const side = Math.min(512,width,height); return {width:side,height:side}; }
  const ratio = Math.min(1,1280 / Math.max(width,height),Math.sqrt(1000000 / (width * height)));
  return {width:Math.max(1,Math.floor(width * ratio)),height:Math.max(1,Math.floor(height * ratio))};
}

export function mayUseV1(method, status) { return method === 'GET' && status === 404; }
export function memberRecord(value) {
  if (value?.schema_version !== 2 || !canonicalKey(value.user_id) || typeof value.email !== 'string' ||
      !value.email || value.email.length > 254 || !isoDateTime(value.email_verified_at) || !isoDateTime(value.consent_at) ||
      !Number.isSafeInteger(value.profile_version) || value.profile_version < 0 ||
      typeof value.device_bound !== 'boolean' || typeof value.is_admin !== 'boolean') throw new Error('个人资料响应不完整。');
  return {schema_version:2,user_id:value.user_id,email:value.email,email_verified_at:value.email_verified_at,
    consent_at:value.consent_at,profile_version:value.profile_version,profile:publicProfile(value.profile),
    device_bound:value.device_bound,is_admin:value.is_admin};
}

function initialize() {
  const $ = function (selector) { return document.querySelector(selector); };
  const isPublic = document.body.dataset.mode === 'public';
  const apiBase = isPublic
    ? 'https://cloud1-d1gwtdw2y9153c1b3-1499259329.ap-shanghai.app.tcloudbase.com/yak-yogurt/'
    : document.baseURI;
  const mode = isPublic ? {
    label: '云端汇总', saved: '云端已保存汇总', script: 'report-public.mjs',
    scope: '当前展示已配置电脑上报的 Claude Code 与 Codex 汇总。网页读取云端已保存的数据，不会自动采集设备日志。未上报的设备与缺失日志不在统计范围内。',
    report: '在已配置上报的电脑上，进入项目目录。先预览，确认后手动上报，再刷新网页。当前命令更新本周，网页切换日期不会重新采集日志。',
    retry: '请检查网络后重新读取云端数据。',
  } : {
    label: '本机汇总', saved: '本机已保存汇总', script: 'report-usage.mjs',
    scope: '当前展示这台电脑已保存的 Claude Code 与 Codex 汇总。刷新网页不会重新采集日志；其他设备与缺失日志不在统计范围内。',
    report: '在项目目录打开终端。先预览本周统计，确认后手动上报到本机，再刷新网页。网页切换日期不会重新采集日志。',
    retry: '请确认本机服务仍在运行，再重新读取。',
  };
  const state = { data:null,day:null,selectedDate:beijingDate(),tool:'all',pending:false,activeTab:'board',apiVersion:null,
    detail:null,scopeUser:'all',detailRequest:0,capabilities:null,member:null,session:null,challenge:null,authBusy:false };
  const integerFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const dayFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const fullNumber = function (value) { return integerFormatter.format(Number.isSafeInteger(value) && value >= 0 ? value : 0); };
  const text = function (selector, value) { $(selector).textContent = value; };
  const make = function (tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  };
  const monthDay = function (date) { return Number(date.slice(5, 7)) + '.' + Number(date.slice(8, 10)); };
  const compactNumber = function (value) {
    if (value >= 100000000) return { number: (value / 100000000).toFixed(2), unit: '亿 tokens' };
    if (value >= 10000) return { number: (value / 10000).toFixed(2), unit: '万 tokens' };
    return { number: fullNumber(value), unit: 'tokens' };
  };
  const safeTimestamp = function (stamp) {
    if (typeof stamp !== 'string') return null;
    const date = new Date(stamp);
    return Number.isFinite(date.getTime()) ? dateTimeFormatter.format(date) : null;
  };

  function showTab(name, focus = false) {
    const names = ['board', 'usage', 'me', 'about'];
    if (!names.includes(name)) return;
    state.activeTab = name;
    for (const item of document.querySelectorAll('[data-tab]')) {
      const active = item.dataset.tab === name;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      $('#panel-' + item.dataset.tab).hidden = !active;
      if (active && focus) item.focus();
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  function updateDateControls() {
    const today = beijingDate();
    $('#selected-date').value = state.selectedDate;
    $('#selected-date').max = today;
    $('#date-today').setAttribute('aria-pressed', String(state.selectedDate === today));
    $('#date-yesterday').setAttribute('aria-pressed', String(state.selectedDate === addDays(today, -1)));
    text('#day-label', dayFormatter.format(new Date(state.selectedDate + 'T00:00:00Z')));
  }
  function renderProject(profile) {
    text('#project-owner', profile.nickname ? profile.nickname + ' · 当前作品' : '当前作品');
    text('#project-name', profile.project_name || '还没有填写作品');
    text('#project-description', profile.project_description || '让投入和正在创造的东西连在一起。');
    const href = safeLink(profile.project_url);
    $('#project-link').hidden = !href;
    if (href) $('#project-link').href = href; else $('#project-link').removeAttribute('href');
  }
  function renderDay() {
    const day = state.day;
    const container = $('#day-rows');
    container.replaceChildren();
    $('#empty-state').hidden = day.rows.length > 0;
    if (!day.has_snapshot) {
      text('#empty-title', '所选周还没有保存的上报快照');
      text('#empty-description', '还不能判断这一天的实际用量；缺少记录不会显示为 0。切换其他日期，或在已配置电脑上手动上报后刷新。');
    }
    for (const row of day.rows) {
      const tr = make('tr');
      const rank = make('td', 'rank-cell');
      rank.append(make('span', 'day-rank', row.rank === null ? '—' : String(row.rank).padStart(2, '0')));
      const creatorCell = make('td', 'creator-cell');
      const creator = make('div', 'creator');
      creator.append(makeAvatar(row));
      const identity = make('div');
      if (row.user_id) {
        const personal = make('button','creator-name creator-button',row.nickname || '未命名创作者');
        personal.type='button';personal.setAttribute('aria-label','查看 '+(row.nickname||'该创作者')+' 的个人用量');
        personal.addEventListener('click',function(){showTab('usage');loadV2Detail(state.selectedDate,row.user_id);});identity.append(personal);
      } else identity.append(make('span','creator-name',row.nickname || '未命名创作者'));
      if (row.city) identity.append(make('span', 'creator-city', row.city));
      creator.append(identity);
      creatorCell.append(creator);
      const toolCell = make('td', 'tools-cell');
      toolCell.dataset.label = '工具';
      const tools = make('div', 'row-tools');
      for (const tool of row.tools) tools.append(make('span', 'tool-chip', tool));
      if (!row.tools.length) tools.append(make('span', 'muted', row.status === 'not_reported' ? '未上报' : '无正用量工具'));
      toolCell.append(tools);
      const workCell = make('td', 'project-cell');
      workCell.dataset.label = '作品';
      const href = safeLink(row.project_url);
      if (row.cover_ref) {const cover=make('img','work-cover');cover.alt='';setMediaImage(cover,row.cover_ref);workCell.append(cover);}
      if (href) {
        const link = make('a', '', row.project_name || '查看作品');
        link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        workCell.append(link);
      } else workCell.append(make('span', '', row.project_name || '未填写'));
      const totalCell = make('td', 'day-total');
      totalCell.dataset.label = '日消耗 tokens';
      if (row.total_tokens === null) {
        totalCell.append(make('strong', 'unreported', '未上报'), make('small', '', '没有当日用量行'));
      } else {
        totalCell.append(make('strong', '', fullNumber(row.total_tokens)),
          make('small', '', row.status === 'reported_zero' ? '已上报 · 明确为 0' : 'tokens'));
      }
      tr.append(rank, creatorCell, toolCell, workCell, totalCell);
      container.append(tr);
    }
    const time = day.is_today ? '本日尚未结束' : day.is_future ? '日期尚未到来' : '该日已结束';
    const updated = safeTimestamp(day.updated_at);
    const saved = updated ? '所在周最近上报 ' + updated + ' · 北京时间' : '所选周尚未保存快照';
    text('#day-timing', time + ' · ' + saved);
    const note = day.status === 'not_reported'
      ? '已保存所在周的快照，但没有这一天的用量行；不能认定实际用量为 0。'
      : day.status === 'reported_zero'
        ? '已找到这一天的上报行，四类计数均为 0。工具列只列当天有正用量的工具。'
        : '只展示已保存的上报汇总；当天工具取自所选日期，数字会随手动上报更新。';
    text('#board-note', note);
  }
  function renderChart(rows, start) {
    const chart = $('#daily-chart'); chart.replaceChildren();
    const today = beijingDate();
    const days = Array.from({ length: 7 }, function (_, index) { return { date: addDays(start, index), total: 0, recorded: false }; });
    const map = new Map(days.map(function (day) { return [day.date, day]; }));
    for (const row of rows) {
      if (map.has(row.date)) {
        const day = map.get(row.date); day.total += row.total_tokens; day.recorded = true;
      }
    }
    const max = Math.max(1, ...days.map(function (day) { return day.total; }));
    const weekDays = ['一', '二', '三', '四', '五', '六', '日'];
    for (let index = 0; index < days.length; index++) {
      const day = days[index], column = make('div', 'chart-column');
      const absent = day.date > today ? '日期未到' : '没有当日记录';
      const description = day.recorded ? fullNumber(day.total) + ' tokens' : absent;
      column.setAttribute('aria-label', day.date + '，' + description); column.title = day.date + ' · ' + description;
      const compact = compactNumber(day.total);
      column.append(make('span', 'chart-value', day.recorded ? compact.number + compact.unit.replace(' tokens', '').replace('tokens', '') : '—'));
      const track = make('div', 'chart-track'), bar = make('div', 'chart-bar' + (day.total ? '' : ' zero'));
      bar.style.height = String(day.total ? Math.max(3, day.total / max * 100) : 2) + '%';
      track.append(bar);
      column.append(track, make('span', 'chart-day', '周' + weekDays[index]), make('span', 'chart-date', monthDay(day.date)));
      chart.append(column);
    }
    text('#chart-caption', '所在周已有 ' + days.filter(function (day) { return day.recorded; }).length + ' 个日期的用量行；— 表示没有当日记录，不当作 0。');
  }
  function renderModels(rows) {
    const container = $('#model-list'); container.replaceChildren();
    const groups = new Map();
    for (const row of rows) {
      const key = JSON.stringify([row.tool, row.model]);
      if (!groups.has(key)) groups.set(key, { tool: row.tool, model: row.model === 'unknown' ? '未知模型' : row.model, total: 0 });
      groups.get(key).total += row.total_tokens;
    }
    const models = [...groups.values()].sort(function (a, b) { return b.total - a.total; });
    const total = summarizeUsage(rows).total_tokens;
    text('#model-count', models.length + ' 个模型记录');
    if (!models.length) { container.append(make('p', 'small-note', '所在周还没有可显示的模型汇总。')); return; }
    for (const model of models) {
      const item = make('div', 'model-item'), heading = make('div', 'model-heading'), identity = make('div', 'model-identity');
      identity.append(make('strong', '', model.model), make('span', '', model.tool));
      heading.append(identity, make('span', 'model-total', fullNumber(model.total)));
      const track = make('div', 'model-track'), fill = make('div', 'model-fill');
      fill.style.width = String(total ? model.total / total * 100 : 0) + '%';
      track.append(fill); item.append(heading, track); container.append(item);
    }
  }
  function renderDetails() {
    if (!state.day) return;
    if (state.apiVersion === 2 && !state.detail) return;
    const sourceRows = state.apiVersion === 2 ? state.detail.daily : state.day.weekly_rows;
    const hasRows = state.apiVersion === 2 ? sourceRows.length > 0 : state.day.has_snapshot;
    const rows = sourceRows.filter(function (row) { return state.tool === 'all' || row.tool === state.tool; });
    const totals = summarizeUsage(rows);
    text('#detail-input', hasRows ? fullNumber(totals.input_tokens) : '—'); text('#detail-output', hasRows ? fullNumber(totals.output_tokens) : '—');
    text('#detail-write', hasRows ? fullNumber(totals.cache_creation_input_tokens) : '—'); text('#detail-read', hasRows ? fullNumber(totals.cache_read_input_tokens) : '—');
    const period = state.apiVersion === 2 ? '所选日' : '所在周';
    text('#filter-caption',(state.tool === 'all'?'下方为全部工具':'下方仅显示 '+state.tool)+'的'+period+'明细；筛选不改变首页日榜或上方总量。');
    if(state.apiVersion===2){text('#chart-heading','当日工具用量');text('#chart-kind','所选日工具分布');renderV2ToolChart(rows);}
    else{$('#daily-chart').style.gridTemplateColumns='';text('#chart-heading','每日走势');text('#chart-kind','所在周每日 tokens');renderChart(rows,state.day.week_start);}
    renderModels(rows);
  }
  function costLabel(estimate) {
    if (!estimate || typeof estimate.min !== 'number' || typeof estimate.max !== 'number' ||
        !Number.isFinite(estimate.min) || !Number.isFinite(estimate.max) || estimate.min < 0 || estimate.max < estimate.min) return '暂不能估算';
    if (Math.abs(estimate.max - estimate.min) < 0.005) return currencyFormatter.format(estimate.min);
    return currencyFormatter.format(estimate.min) + '–' + currencyFormatter.format(estimate.max);
  }
  function renderUsage() {
    const data = state.data, day = state.day;
    $('#overview').setAttribute('aria-label','所选日期所在周的用量概览');
    $('.tool-filters').setAttribute('aria-label','筛选所在周的明细工具');
    $('#daily-chart').setAttribute('aria-label','所在周每日用量柱状图');
    text('#aggregate-caption','所在周总用量');$('#usage-all-scope').hidden=true;$('#usage-member-profile').hidden=true;$('#usage-error').hidden=true;
    const totals = summarizeUsage(day.weekly_rows), compact = compactNumber(totals.total_tokens);
    text('#usage-period', '所选日期所在自然周：' + day.week_start + ' 至 ' + addDays(day.week_start, 6) + ' · 北京时间。以下展示整周，不是单日合计。');
    text('#total-tokens', day.has_snapshot ? compact.number : '—'); $('#total-tokens').title = day.has_snapshot ? fullNumber(totals.total_tokens) + ' tokens' : '尚无已保存快照';
    text('#total-unit', day.has_snapshot ? compact.unit : 'tokens'); text('#without-cache', day.has_snapshot ? fullNumber(totals.total_without_cache_read_tokens) + ' tokens' : '—');
    text('#cost-estimate', day.has_snapshot ? costLabel(data.estimate) : '暂无快照');
    let detail = '标准 API 参考估算，不是订阅费用或实际账单。';
    if (Number.isSafeInteger(data.estimate?.unpriced_tokens) && data.estimate.unpriced_tokens > 0) detail += '另有 ' + fullNumber(data.estimate.unpriced_tokens) + ' tokens 无对应价格，未计入。';
    if (typeof data.estimate?.label === 'string') detail += ' ' + data.estimate.label;
    if (typeof data.pricing_checked_at === 'string') detail += ' 价格核对：' + data.pricing_checked_at + '。';
    text('#cost-detail', detail);
    const updated = safeTimestamp(data.updated_at);
    text('#update-status', updated ? '所在周最近上报 ' + updated + ' · 北京时间 · ' + mode.saved : '所在周尚未保存上报快照。');
    const diagnostics = data.diagnostics && typeof data.diagnostics === 'object' ? Object.entries(data.diagnostics).filter(function (pair) { return Number.isSafeInteger(pair[1]) && pair[1] > 0; }) : [];
    $('#diagnostics-list').replaceChildren();
    for (const pair of diagnostics) $('#diagnostics-list').append(make('li', '', pair[0] + '：' + fullNumber(pair[1])));
    $('#diagnostics-note').hidden = diagnostics.length === 0;
    renderDetails();
  }
  function renderSavedData() {
    state.day = dayBoardFromWeekly(state.data, state.selectedDate);
    renderDay(); renderUsage(); renderProject(state.day.profile);
  }
  function setPending(pending) {
    state.pending = pending;
    for (const id of ['#date-today', '#date-yesterday', '#selected-date', '#refresh-button', '#retry-button']) $(id).disabled = pending;
    $('#day-board').setAttribute('aria-busy', String(pending)); $('#overview').setAttribute('aria-busy', String(pending));
  }

  const SESSION_KEY = 'yak-yogurt-member-session-v2';
  const transientDownloads = new Set();
  function mediaUrl(ref) {
    mediaReference(ref);
    const url = new URL('api/v2/media',apiBase); url.searchParams.set('ref',ref); return url.href;
  }
  function setMediaImage(node, ref) {
    node.hidden = !ref;
    if (!ref) { node.removeAttribute('src'); return; }
    mediaReference(ref);
    node.crossOrigin = 'anonymous'; node.referrerPolicy = 'no-referrer'; node.src = mediaUrl(ref);
    node.onerror = function () { node.hidden = true; };
  }
  function makeAvatar(profile) {
    const box = make('span','creator-avatar',Array.from(profile.nickname || '我')[0]);
    if (profile.avatar_ref) {
      const image = make('img','member-avatar'); image.alt = ''; setMediaImage(image,profile.avatar_ref); box.append(image);
    }
    return box;
  }
  async function v2Request(path, {method = 'GET',body,authorized = false} = {}) {
    const url = new URL('api/v2/' + path,apiBase);
    const controller = new AbortController(), timeout = setTimeout(function(){controller.abort();},15000);
    try {
      if (authorized && !state.session) throw new Error('请先通过邮箱验证码登录。');
      const response = await fetch(url,{method,credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal,
        headers:{Accept:'application/json',...(body !== undefined ? {'Content-Type':'application/json'} : {}),
          ...(authorized ? {Authorization:'Bearer ' + state.session.session_token} : {})},
        ...(body !== undefined ? {body:JSON.stringify(body)} : {})});
      let value;
      try { value = await response.json(); } catch { const error = new Error('服务暂未提供可读取的响应。'); error.status = response.status; throw error; }
      if (!response.ok) {
        const error = new Error(typeof value?.error === 'string' ? value.error : '请求暂未完成，请稍后重试。');
        error.status = response.status; throw error;
      }
      return value;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('请求超时，请稍后重试。');
      if (error instanceof TypeError) throw new Error(mode.retry);
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function memberMessage(value) { text('#member-message',value); }
  function clearSession() {
    state.session = null; state.member = null; state.challenge = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch {}
    for (const cleanup of transientDownloads) cleanup(); transientDownloads.clear();
    $('#device-download').replaceChildren();
    $('#member-signed-in').hidden = true; $('#member-signed-out').hidden = false;
    $('#verify-code-form').hidden = true; $('#admin-invites').hidden = true; $('#invite-result').hidden = true;
    $('#invite-link').value = ''; $('#auth-code').value = ''; $('#public-consent').checked = false;
    $('#member-email').textContent = '';
    for (const field of ['nickname','city','project-name','description','project-url','avatar-ref','cover-ref']) $('#profile-' + field).value = '';
    for (const slot of ['avatar','cover']) { $('#profile-' + slot + '-file').value = ''; setMediaImage($('#profile-' + slot + '-preview'),''); }
  }
  function updateMemberControls() {
    const capabilities = state.capabilities;
    $('#request-code-button').disabled = state.authBusy || !capabilities?.enabled || !capabilities?.auth_ready;
    for (const node of document.querySelectorAll('[data-member-write]')) node.disabled = state.authBusy || !state.member;
    for (const node of document.querySelectorAll('[data-media-slot]')) node.disabled = state.authBusy || !state.member || !capabilities?.media_ready;
    $('#member-logout').disabled = state.authBusy;
    if (state.member) {
      $('#device-create').hidden = state.member.device_bound; $('#device-rotate').hidden = !state.member.device_bound; $('#device-revoke').hidden = !state.member.device_bound;
      text('#device-status',state.member.device_bound ? '当前有一份有效上报配置；完整密钥不会在页面显示。' : '还没有有效上报配置。');
      text('#media-status',capabilities?.media_ready ? '选图后会先上传，保存资料才将图片引用公开到个人资料。' : '图片服务尚未配置，可以先保存文字资料。');
    }
  }
  async function memberAction(operation) {
    if (state.authBusy) return;
    state.authBusy = true; updateMemberControls();
    try { await operation(); }
    catch (error) {
      if (error?.status === 401 && state.session) { clearSession(); memberMessage('登录已失效，请重新获取邮箱验证码。'); }
      else memberMessage(error instanceof Error ? error.message : '本次操作未完成，请稍后重试。');
    } finally { state.authBusy = false; updateMemberControls(); }
  }
  function renderMember(value) {
    value = memberRecord(value);
    const profile = value.profile;
    state.member = value;
    $('#member-signed-out').hidden = true; $('#member-signed-in').hidden = false;
    text('#member-name',profile.nickname || '个人资料');
    text('#member-email',value.email + (value.email_verified_at ? ' · 邮箱已验证' : ''));
    const bindings = {'nickname':'nickname','city':'city','project-name':'project_name','description':'project_description','project-url':'project_url','avatar-ref':'avatar_ref','cover-ref':'cover_ref'};
    for (const [id,key] of Object.entries(bindings)) $('#profile-' + id).value = profile[key];
    setMediaImage($('#profile-avatar-preview'),profile.avatar_ref); setMediaImage($('#profile-cover-preview'),profile.cover_ref);
    $('#admin-invites').hidden = !value.is_admin;
    updateMemberControls();
  }
  async function loadCapabilities() {
    try {
      const value = await v2Request('config');
      if (value?.schema_version !== 2 || ['enabled','auth_ready','media_ready'].some(key => typeof value[key] !== 'boolean')) throw new Error('能力响应不完整。');
      state.capabilities = value;
      if (!state.session) memberMessage(!value.enabled ? '个人中心暂未启用，公开日榜仍可查看。' :
        !value.auth_ready ? '邮箱验证码尚未配置，目前无法发送；公开日榜仍可查看。' : '用邮箱验证码加入或登录，首次加入需要邀请码。');
    } catch (error) {
      state.capabilities = {enabled:false,auth_ready:false,media_ready:false};
      if (!state.session) memberMessage(error?.status === 404 ? '当前后端尚未开通个人中心，公开日榜仍可查看。' : '暂时无法确认个人中心能力，请稍后刷新。');
    } finally { updateMemberControls(); }
  }
  async function restoreMemberSession() {
    let saved;
    try { saved = sessionRecord(JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null')); } catch {}
    if (!saved) { try { sessionStorage.removeItem(SESSION_KEY); } catch {} return; }
    state.session = saved;
    try { renderMember(await v2Request('me',{authorized:true})); memberMessage('已恢复本次浏览器的登录状态。'); }
    catch { clearSession(); memberMessage('原登录状态已失效，请重新获取邮箱验证码。'); }
  }
  function readProfile() {
    return publicProfile({
      nickname:$('#profile-nickname').value.trim(),city:$('#profile-city').value.trim(),
      project_name:$('#profile-project-name').value.trim(),project_description:$('#profile-description').value.trim(),
      project_url:$('#profile-project-url').value.trim(),avatar_ref:$('#profile-avatar-ref').value,cover_ref:$('#profile-cover-ref').value,
    });
  }
  async function jpegForUpload(file, slot) {
    if (!file || !/^image\/(?:jpeg|png|webp|gif|avif|heic|heif)$/.test(file.type) || file.size > 15 * 1024 * 1024) throw new Error('请选择15MB以内可读取的照片（JPEG、PNG等）。');
    const localUrl = URL.createObjectURL(file), image = new Image();
    try {
      await new Promise(function(resolve,reject){image.onload = resolve; image.onerror = function(){reject(new Error('浏览器无法读取这张图，请换成 JPEG 或 PNG。'));}; image.src = localUrl;});
      let size = imageOutputSize(slot,image.naturalWidth,image.naturalHeight);
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
      if (!context) throw new Error('当前浏览器暂不能处理图片。');
      const limit = slot === 'avatar' ? 128 * 1024 : 256 * 1024;
      for (let attempt = 0; attempt < 12; attempt++) {
        canvas.width = size.width; canvas.height = size.height;
        context.fillStyle = '#ffffff'; context.fillRect(0,0,size.width,size.height);
        if (slot === 'avatar') {
          const side = Math.min(image.naturalWidth,image.naturalHeight);
          context.drawImage(image,(image.naturalWidth-side)/2,(image.naturalHeight-side)/2,side,side,0,0,size.width,size.height);
        } else context.drawImage(image,0,0,size.width,size.height);
        const quality = Math.max(.35,.88 - attempt * .08);
        const blob = await new Promise(function(resolve){canvas.toBlob(resolve,'image/jpeg',quality);});
        if (!blob) throw new Error('图片转换未完成，请换一张图。');
        if (blob.size <= limit) {
          const bytes = new Uint8Array(await blob.arrayBuffer()), parts = [];
          for (let index = 0; index < bytes.length; index += 8192) parts.push(String.fromCharCode(...bytes.subarray(index,index+8192)));
          return btoa(parts.join(''));
        }
        if (quality <= .4) size = {width:Math.max(1,Math.floor(size.width * .8)),height:Math.max(1,Math.floor(size.height * .8))};
      }
      throw new Error('图片仍然过大，请换一张更简单的图片。');
    } finally { image.src = ''; URL.revokeObjectURL(localUrl); }
  }
  async function generateDevice(action) {
    await memberAction(async function(){
      const response = await v2Request('me/device',{method:'POST',body:{action},authorized:true});
      if (response?.ok !== true) throw new Error('服务未确认配置生成，未提供下载。');
      const config = generatedClientConfig(response.client_config);
      for (const cleanup of transientDownloads) cleanup(); transientDownloads.clear();
      const holder = $('#device-download'); holder.replaceChildren();
      const blob = new Blob([JSON.stringify(config,null,2) + '\n'],{type:'application/json'});
      const url = URL.createObjectURL(blob), link = make('a','primary-button','下载 public-client-v2.json');
      link.href = url; link.download = 'public-client-v2.json';
      const cleanup = function(){URL.revokeObjectURL(url);link.removeAttribute('href');link.setAttribute('aria-disabled','true');};
      transientDownloads.add(cleanup);
      link.addEventListener('click',function(){setTimeout(function(){cleanup();transientDownloads.delete(cleanup);link.textContent = '本次下载已触发；配置不再重复展示';},1000);},{once:true});
      holder.append(make('p','small-note','请先下载并解压上方采集工具，再点击下载配置，放入工具根目录的 .runtime 文件夹。配置仅在这次生成时提供，不会自动下载或保存到浏览器会话存储。'),link);
      state.member.device_bound = true; memberMessage('专用配置已生成，请主动点击下载并妥善保管。');
    });
  }
  function renderV2Board(board) {
    const today = beijingDate();
    state.day = {date:board.date,rows:board.rows,has_snapshot:board.rows.length>0,updated_at:board.updated_at,
      status:board.rows.length?'reported':'not_reported',is_today:board.date===today,is_future:board.date>today,profile:board.rows[0] || {}};
    renderDay();
    if (!board.rows.length) {
      text('#empty-title','这一天还没有已上报记录');
      text('#empty-description','未上报不等于实际用量为 0；有明确零用量上报时才显示 0。');
      text('#day-timing',(board.date===today?'本日尚未结束':'该日已结束') + ' · 还没有当日上报汇总');
    }
    text('#board-note','日榜展示已授权公开的当日汇总。点创作者可查看其个人明细；工具只列当日有用量的工具。');
  }
  function renderV2ToolChart(rows) {
    const chart = $('#daily-chart'); chart.replaceChildren(); chart.style.gridTemplateColumns = 'repeat(2,minmax(0,1fr))';
    const values = TOOL_ORDER.map(tool => ({tool,total:summarizeUsage(rows.filter(row=>row.tool===tool)).total_tokens}));
    const max = Math.max(1,...values.map(value=>value.total));
    for (const value of values) {
      const column = make('div','chart-column'), number = compactNumber(value.total), track = make('div','chart-track'), bar = make('div','chart-bar' + (value.total?'':' zero'));
      column.setAttribute('aria-label',value.tool + '，' + fullNumber(value.total) + ' tokens');
      column.append(make('span','chart-value',number.number + number.unit.replace(' tokens','').replace('tokens','')));
      bar.style.height = (value.total?Math.max(3,value.total/max*100):2) + '%'; track.append(bar);
      column.append(track,make('span','chart-day',value.tool)); chart.append(column);
    }
    text('#chart-caption','这里只展示所选日的工具分布，不把其他日期当作零。');
  }
  function renderV2Usage() {
    const detail = state.detail;
    $('#overview').setAttribute('aria-label','所选日的用量概览');
    $('.tool-filters').setAttribute('aria-label','筛选所选日的明细工具');
    $('#daily-chart').setAttribute('aria-label','所选日工具用量柱状图');
    text('#aggregate-caption','所选日总用量');text('#chart-heading','当日工具用量');text('#chart-kind','所选日工具分布');
    $('#usage-all-scope').hidden = state.scopeUser === 'all';
    if (!detail) {
      text('#usage-period',state.selectedDate + ' · 正在读取所选范围的当日用量');
      return;
    }
    const scope = detail.scope === 'all' ? '全站' : (detail.profile?.nickname || '该创作者') + '个人';
    const hasRows = detail.daily.length > 0, compact = compactNumber(detail.totals.total_tokens);
    text('#usage-period',detail.date + ' · ' + scope + '当日汇总；不是整周或累计总量。');
    text('#aggregate-caption',scope + '当日总用量');
    text('#total-tokens',hasRows?compact.number:'—'); text('#total-unit',hasRows?compact.unit:'tokens');
    $('#total-tokens').title = hasRows?fullNumber(detail.totals.total_tokens) + ' tokens':'还没有当日记录';
    text('#without-cache',hasRows?fullNumber(detail.totals.total_without_cache_read_tokens) + ' tokens':'—');
    text('#cost-estimate',detail.estimate?costLabel(detail.estimate):'未提供估算');
    text('#cost-detail','当前展示所选日与所选范围。接口未提供的价格不沿用旧周估算；参考价也不等于实际账单。');
    text('#update-status',(safeTimestamp(detail.updated_at)?'最近上报 ' + safeTimestamp(detail.updated_at) + ' · 北京时间':'所选范围还没有当日上报') + ' · ' + mode.saved);
    const diagnostics = detail.diagnostics && typeof detail.diagnostics === 'object' ? Object.entries(detail.diagnostics) : [];
    $('#diagnostics-list').replaceChildren();
    for (const [name,count] of diagnostics) if (Number.isSafeInteger(count) && count > 0) $('#diagnostics-list').append(make('li','',name + '：' + fullNumber(count)));
    $('#diagnostics-note').hidden = !$('#diagnostics-list').children.length;
    const profileCard = $('#usage-member-profile'); profileCard.replaceChildren(); profileCard.hidden = !detail.profile;
    if (detail.profile) {
      const profile = detail.profile; profileCard.append(makeAvatar(profile));
      const info = make('div','project-copy'); info.append(make('h2','',profile.nickname),make('p','small-note',profile.city || ''));
      if (profile.project_name) info.append(make('p','',profile.project_name));
      if (profile.project_description) info.append(make('p','small-note',profile.project_description));
      const href = safeLink(profile.project_url);
      if (href) { const link = make('a','text-button','查看作品 ↗');link.href=href;link.target='_blank';link.rel='noopener noreferrer';info.append(link); }
      if (profile.cover_ref) {const cover=make('img','profile-cover-preview');cover.alt='作品封面';setMediaImage(cover,profile.cover_ref);info.append(cover);}
      profileCard.append(info);
    }
    renderDetails();
  }
  async function loadV2Detail(date, user = 'all') {
    state.scopeUser = user; state.detail = null; const requestId = ++state.detailRequest;
    $('#usage-error').hidden = true;
    for (const id of ['#total-tokens','#without-cache','#cost-estimate','#detail-input','#detail-output','#detail-write','#detail-read','#model-count']) text(id,'—');
    $('#model-list').replaceChildren(); $('#daily-chart').replaceChildren(); $('#usage-member-profile').hidden=true;
    renderV2Usage();
    try {
      const query = new URLSearchParams({date,user});
      const detail = normalizeV2Detail(await v2Request('detail?' + query),date,user);
      if (requestId !== state.detailRequest || date !== state.selectedDate) return;
      state.detail = detail; renderV2Usage();
    } catch (error) {
      if (requestId !== state.detailRequest || date !== state.selectedDate) return;
      text('#usage-error',error instanceof Error?error.message:'当日明细暂未读取。'); $('#usage-error').hidden=false;
      text('#usage-period',date + ' · 当日明细暂未读取；首页日榜仍可查看。');
    }
  }
  function connectMemberForms() {
    const hash = new URLSearchParams(location.hash.replace(/^#/,''));
    if (hash.has('invite')) {
      const invite = hash.get('invite');
      if (canonicalKey(invite)) {$('#auth-invite').value=invite;$('#auth-purpose').value='join';}
      else memberMessage('邀请链接格式无效，请向邀请人索取新链接。');
      history.replaceState(null,'',location.pathname+location.search);
    }
    function purposeChanged(){const joining=$('#auth-purpose').value==='join';$('#invite-label').hidden=!joining;$('#auth-invite').required=joining;}
    $('#auth-purpose').addEventListener('change',purposeChanged); purposeChanged();
    $('#request-code-form').addEventListener('submit',function(event){event.preventDefault();memberAction(async function(){
      if (!state.capabilities?.enabled || !state.capabilities?.auth_ready) throw new Error('邮箱验证码尚未配置，目前无法发送。');
      if (!$('#request-code-form').reportValidity()) return;
      const purpose=$('#auth-purpose').value,email=$('#auth-email').value.trim();
      const invite=$('#auth-invite').value.trim();
      if(purpose==='join'&&!canonicalKey(invite))throw new Error('请输入有效的一次性邀请码。');
      const result=await v2Request('auth/request-code',{method:'POST',body:{email,purpose,...(purpose==='join'?{invite_code:invite}:{})}});
      if(result?.ok!==true||!canonicalKey(result.challenge_id))throw new Error('服务没有确认验证码请求，请稍后重试。');
      state.challenge=result.challenge_id;$('#verify-code-form').hidden=false;$('#auth-code').focus();
      memberMessage('验证码请求已受理，请查看邮箱；未收到时请稍后重试。');
    });});
    $('#verify-code-form').addEventListener('submit',function(event){event.preventDefault();memberAction(async function(){
      if(!state.challenge||!$('#verify-code-form').reportValidity()||!$('#public-consent').checked)throw new Error('请输入六位验证码，并勾选公开资料同意项。');
      const result=await v2Request('auth/verify-code',{method:'POST',body:{challenge_id:state.challenge,code:$('#auth-code').value.trim(),consent:true}});
      const saved=sessionRecord({session_token:result?.session_token,expires_at:result?.expires_at});
      if(result?.ok!==true||!saved)throw new Error('服务没有返回有效登录状态。');
      state.session=saved;
      try{renderMember(result.member);}catch(error){clearSession();throw error;}
      try{sessionStorage.setItem(SESSION_KEY,JSON.stringify(saved));}catch{}
      state.challenge=null;$('#auth-code').value='';$('#auth-invite').value='';memberMessage('邮箱已验证，个人中心已接入。');
    });});
    $('#member-logout').addEventListener('click',function(){memberAction(async function(){
      let confirmed=false;try{const result=await v2Request('auth/logout',{method:'POST',body:{},authorized:true});confirmed=result?.ok===true;}catch{}finally{clearSession();}
      memberMessage(confirmed?'已退出本次登录。':'已清除本页登录状态，服务端退出尚未确认。');
    });});
    $('#profile-form').addEventListener('submit',function(event){event.preventDefault();memberAction(async function(){
      if(!state.member||!$('#profile-form').reportValidity())return;
      const result=await v2Request('me',{method:'PUT',body:{profile_version:state.member.profile_version,profile:readProfile()},authorized:true});
      renderMember(result);memberMessage('公开资料已保存；刷新榜单可读取最新资料。');
    });});
    for(const input of document.querySelectorAll('[data-media-slot]'))input.addEventListener('change',function(){memberAction(async function(){
      const slot=input.dataset.mediaSlot;
      if(!state.capabilities?.media_ready)throw new Error('图片服务尚未配置。');
      if(!input.files?.[0])return;
      memberMessage('正在处理并上传图片…');
      const jpeg_base64=await jpegForUpload(input.files[0],slot);
      const result=await v2Request('me/media',{method:'POST',body:{slot,jpeg_base64},authorized:true});
      if(result?.ok!==true)throw new Error('图片上传未确认。');
      mediaReference(result.ref,slot);$('#profile-'+slot+'-ref').value=result.ref;setMediaImage($('#profile-'+slot+'-preview'),result.ref);
      input.value='';memberMessage('图片已上传，请点「保存公开资料」使资料引用生效。');
    });});
    $('#device-create').addEventListener('click',function(){generateDevice('create');});
    $('#device-rotate').addEventListener('click',function(){generateDevice('rotate');});
    $('#device-revoke').addEventListener('click',function(){memberAction(async function(){
      const result=await v2Request('me/device/revoke',{method:'POST',body:{},authorized:true});
      if(result?.ok!==true)throw new Error('停用操作未确认。');
      for(const cleanup of transientDownloads)cleanup();transientDownloads.clear();$('#device-download').replaceChildren();
      state.member.device_bound=false;memberMessage('上报配置已停用，原配置不能继续上报。');
    });});
    $('#invite-create').addEventListener('click',function(){memberAction(async function(){
      if(!state.member?.is_admin)throw new Error('当前账号没有生成邀请的权限。');
      const result=await v2Request('admin/invites',{method:'POST',body:{expires_in_hours:72},authorized:true});
      if(result?.ok!==true||!canonicalKey(result.invite_code)||!isoDateTime(result.expires_at))throw new Error('邀请生成未确认。');
      const url=new URL(location.href);url.hash='invite='+encodeURIComponent(result.invite_code);
      $('#invite-link').value=url.href;text('#invite-expiry','有效期至 '+(safeTimestamp(result.expires_at)||result.expires_at)+'（北京时间），仅可使用一次。');
      $('#invite-result').hidden=false;memberMessage('邀请已生成，请主动复制后发给对方。');
    });});
    $('#invite-copy').addEventListener('click',async function(){
      try{if(!navigator.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText($('#invite-link').value);memberMessage('邀请链接已复制。');}
      catch{$('#invite-link').focus();$('#invite-link').select();memberMessage('邀请链接已选中，请手动复制。');}
    });
    window.addEventListener('pagehide',function(){for(const cleanup of transientDownloads)cleanup();transientDownloads.clear();});
    loadCapabilities();restoreMemberSession();
  }

  function clearForLoading() {
    state.data = null; state.day = null; state.detail=null; state.detailRequest++;
    $('#day-rows').replaceChildren(); $('#empty-state').hidden = true;
    text('#day-timing', '正在读取所选日期所在周的已保存汇总…');
    text('#board-note', '切换日期只读取已保存的数据，不会重新采集日志。');
    for (const id of ['#total-tokens', '#without-cache', '#cost-estimate', '#detail-input', '#detail-output', '#detail-write', '#detail-read', '#model-count']) text(id, '—');
    text('#total-unit', 'tokens');
    text('#usage-period', '正在读取 ' + weekStartForDate(state.selectedDate) + ' 所在周…');
    text('#update-status', '正在读取已保存汇总…');text('#cost-detail','当前范围读取完成后显示参考估算；不沿用其他日期的价格。');
    $('#daily-chart').replaceChildren(); $('#model-list').replaceChildren(); $('#diagnostics-note').hidden = true;
    text('#chart-caption', '数据读取后显示所在周走势。');
  }
  async function loadDate(date, force = false) {
    if (state.pending) return;
    const today=beijingDate();
    if(!isDate(date)||date>today){$('#selected-date').value=state.selectedDate;text('#error-message','请选择今天或之前的北京时间日期。');$('#error-banner').hidden=false;return;}
    if(date!==state.selectedDate)state.scopeUser='all';
    state.selectedDate=date;updateDateControls();
    const week=weekStartForDate(date);
    if(!force&&state.apiVersion===1&&state.data?.week?.start===week){renderSavedData();$('#error-banner').hidden=true;return;}
    clearForLoading();setPending(true);
    try{
      let board;
      try{board=normalizeV2Board(await v2Request('leaderboard?'+new URLSearchParams({date})),date);}
      catch(error){if(!mayUseV1('GET',error?.status))throw error;}
      if(board){
        state.apiVersion=2;state.v2Board=board;renderV2Board(board);$('#error-banner').hidden=true;
        text('#preview-command','node scripts/report-community.mjs --preview');text('#submit-command','node scripts/report-community.mjs --submit');
        text('#command-note','每人使用自己的 public-client-v2.json；先预览、确认后手动上报，不要复制他人的密钥。');
        await loadV2Detail(date,state.scopeUser);
      }else{
        const controller=new AbortController(),timer=setTimeout(function(){controller.abort();},15000);
        try{
          const url=new URL('api/leaderboard',apiBase);url.searchParams.set('week',week);
          const response=await fetch(url,{headers:{Accept:'application/json'},cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal});
          let data;try{data=await response.json();}catch{throw new Error('服务返回的周榜格式不正确，请稍后重新读取。');}
          if(!response.ok)throw new Error(typeof data?.error==='string'?data.error:'暂时无法读取已保存数据。');
          dayBoardFromWeekly(data,date);state.apiVersion=1;state.data=data;state.scopeUser='all';renderSavedData();$('#error-banner').hidden=true;
          text('#preview-command','node scripts/'+mode.script+' --preview');text('#submit-command','node scripts/'+mode.script+' --submit');
        }finally{clearTimeout(timer);}
      }
    }catch(error){
      state.data=null;state.day=null;state.detail=null;
      text('#error-message',error?.name==='AbortError'?'读取超时，请稍后重试。':error instanceof Error?error.message:mode.retry);$('#error-banner').hidden=false;
      text('#day-timing','这次读取未完成，不能判断所选日期是否有记录。');text('#update-status',mode.retry);
      text('#empty-title','暂时无法读取这一天');text('#empty-description','请重新读取；连接失败不会显示成零用量。');$('#empty-state').hidden=false;
    }finally{setPending(false);}
  }

  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', function () { showTab(tab.dataset.tab); });
    tab.addEventListener('keydown', function (event) {
      const names = ['board', 'usage', 'me', 'about'], index = names.indexOf(tab.dataset.tab);
      let next;
      if (event.key === 'ArrowRight') next = names[(index + 1) % names.length];
      else if (event.key === 'ArrowLeft') next = names[(index + names.length - 1) % names.length];
      else if (event.key === 'Home') next = names[0];
      else if (event.key === 'End') next = names[names.length - 1];
      if (next) { event.preventDefault(); showTab(next, true); }
    });
  }
  for (const button of document.querySelectorAll('[data-open-tab]')) button.addEventListener('click', function () { showTab(button.dataset.openTab, true); });
  $('#date-today').addEventListener('click', function () { loadDate(beijingDate()); });
  $('#date-yesterday').addEventListener('click', function () { loadDate(addDays(beijingDate(), -1)); });
  $('#selected-date').addEventListener('change', function () { loadDate($('#selected-date').value); });
  $('#refresh-button').addEventListener('click', function () { loadDate(state.selectedDate, true); });
  $('#retry-button').addEventListener('click', function () { loadDate(state.selectedDate, true); });
  for (const button of document.querySelectorAll('[data-tool]')) button.addEventListener('click', function () {
    state.tool = button.dataset.tool;
    for (const item of document.querySelectorAll('[data-tool]')) {
      const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active));
    }
    renderDetails();
  });
  for (const button of document.querySelectorAll('[data-command]')) button.addEventListener('click', async function () {
    const target = $('#' + button.dataset.command + '-command'), command = target.textContent;
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(command); text('#copy-feedback', '已复制，请到已配置电脑的项目目录粘贴运行。');
    } catch {
      const range = document.createRange(); range.selectNodeContents(target);
      const selection = window.getSelection();
      if (selection) { selection.removeAllRanges(); selection.addRange(range); }
      text('#copy-feedback', '命令已选中。电脑可按 Ctrl+C（Mac 按 ⌘C），手机可长按复制。');
    }
  });
  $('#usage-all-scope').addEventListener('click',function(){loadV2Detail(state.selectedDate,'all');});
  connectMemberForms();
  document.title = '有酸奶 Yak Yogurt · 日用量榜';
  text('#mode-label', mode.label);
  text('#scope-note', mode.scope);
  text('#report-description', mode.report);
  text('#mode-footer', mode.saved + ' · 手动上报后更新');
  text('#preview-command', 'node scripts/' + mode.script + ' --preview');
  text('#submit-command', 'node scripts/' + mode.script + ' --submit');
  updateDateControls();
  loadDate(state.selectedDate);
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
}
