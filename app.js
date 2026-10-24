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
  const state = { data: null, day: null, selectedDate: beijingDate(), tool: 'all', pending: false, activeTab: 'board' };
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
      creator.append(make('span', 'creator-avatar', Array.from(row.nickname || '我')[0]));
      const identity = make('div');
      identity.append(make('span', 'creator-name', row.nickname || '未命名创作者'));
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
    const rows = state.day.weekly_rows.filter(function (row) { return state.tool === 'all' || row.tool === state.tool; });
    const totals = summarizeUsage(rows);
    text('#detail-input', state.day.has_snapshot ? fullNumber(totals.input_tokens) : '—'); text('#detail-output', state.day.has_snapshot ? fullNumber(totals.output_tokens) : '—');
    text('#detail-write', state.day.has_snapshot ? fullNumber(totals.cache_creation_input_tokens) : '—'); text('#detail-read', state.day.has_snapshot ? fullNumber(totals.cache_read_input_tokens) : '—');
    text('#filter-caption', (state.tool === 'all' ? '下方为全部工具' : '下方仅显示 ' + state.tool) + '的所在周明细；筛选不改变首页日榜或上方周总量。');
    renderChart(rows, state.day.week_start); renderModels(rows);
  }
  function costLabel(estimate) {
    if (!estimate || typeof estimate.min !== 'number' || typeof estimate.max !== 'number' ||
        !Number.isFinite(estimate.min) || !Number.isFinite(estimate.max) || estimate.min < 0 || estimate.max < estimate.min) return '暂不能估算';
    if (Math.abs(estimate.max - estimate.min) < 0.005) return currencyFormatter.format(estimate.min);
    return currencyFormatter.format(estimate.min) + '–' + currencyFormatter.format(estimate.max);
  }
  function renderUsage() {
    const data = state.data, day = state.day;
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
  function clearForLoading() {
    state.data = null; state.day = null;
    $('#day-rows').replaceChildren(); $('#empty-state').hidden = true;
    text('#day-timing', '正在读取所选日期所在周的已保存汇总…');
    text('#board-note', '切换日期只读取已保存的数据，不会重新采集日志。');
    for (const id of ['#total-tokens', '#without-cache', '#cost-estimate', '#detail-input', '#detail-output', '#detail-write', '#detail-read', '#model-count']) text(id, '—');
    text('#total-unit', 'tokens');
    text('#usage-period', '正在读取 ' + weekStartForDate(state.selectedDate) + ' 所在周…');
    text('#update-status', '正在读取已保存汇总…');
    $('#daily-chart').replaceChildren(); $('#model-list').replaceChildren(); $('#diagnostics-note').hidden = true;
    text('#chart-caption', '数据读取后显示所在周走势。');
  }
  async function loadDate(date, force = false) {
    if (state.pending) return;
    const today = beijingDate();
    if (!isDate(date) || date > today) {
      $('#selected-date').value = state.selectedDate;
      text('#error-message', '请选择今天或之前的北京时间日期。'); $('#error-banner').hidden = false; return;
    }
    state.selectedDate = date; updateDateControls();
    const week = weekStartForDate(date);
    if (!force && state.data?.week?.start === week) {
      renderSavedData(); $('#error-banner').hidden = true; return;
    }
    clearForLoading(); setPending(true);
    const controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 15000);
    try {
      const url = new URL('api/leaderboard', apiBase); url.searchParams.set('week', week);
      const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'omit', signal: controller.signal });
      let data;
      try { data = await response.json(); } catch { throw new Error('服务返回的周榜格式不正确，请稍后重新读取。'); }
      if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : '暂时无法读取已保存数据。');
      dayBoardFromWeekly(data, date);
      state.data = data; renderSavedData(); $('#error-banner').hidden = true;
    } catch (error) {
      state.data = null; state.day = null;
      const message = error?.name === 'AbortError' ? '读取超时，请检查网络后重试。' :
        error instanceof Error && !/^(?:Failed to fetch|Load failed|NetworkError)/i.test(error.message) ? error.message : mode.retry;
      text('#error-message', message); $('#error-banner').hidden = false;
      text('#day-timing', '这次读取未完成，不能判断所选日期是否有记录。');
      text('#update-status', mode.retry);
      text('#empty-title', '暂时无法读取这一天'); text('#empty-description', '请重新读取；连接失败不会显示成零用量。');
      $('#empty-state').hidden = false;
    } finally { clearTimeout(timer); setPending(false); }
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
