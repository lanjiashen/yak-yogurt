'use strict';
const $ = (selector) => document.querySelector(selector);
const FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'total_tokens', 'total_without_cache_read_tokens'];
const state = { data: null, tool: 'all', pending: false };
const isPublic = document.body.dataset.mode === 'public';
const API_BASE = isPublic
  ? 'https://cloud1-d1gwtdw2y9153c1b3-1499259329.ap-shanghai.app.tcloudbase.com/yak-yogurt/'
  : document.baseURI;
const view = isPublic ? {
  badge: '云端汇总', title: '创作者周榜', loading: '正在读取云端已保存汇总…',
  scope: '统计来源：上报电脑可读取的 Claude Code 与 Codex 日志。网页展示云端已保存的汇总，不会自动采集设备日志。未上报的设备与缺失日志不在统计范围内。',
  report: '在已配置上报的电脑上，进入项目目录打开终端。先预览、确认后手动上报，再刷新本页查看云端已保存的汇总。',
  footer: '公开单人版 · 手动上报后更新', script: 'report-public.mjs',
  empty: '云端还没有本周汇总。在已配置上报的电脑上先预览、确认后手动上报，再刷新本页。',
  saved: '云端已保存汇总', notSaved: '尚未上报 · 云端还没有保存这一周的数据',
  unavailable: '云端暂时无法提供周榜，请稍后重新读取。',
  invalid: '服务返回的内容不是有效的周榜数据，请稍后重新读取。',
  incomplete: '周榜数据格式不完整，请稍后刷新重试。',
  retry: '请检查网络后重新读取云端周榜。',
} : {
  badge: '仅在本机运行', title: '本机周榜', loading: '正在读取本机汇总…',
  scope: '统计来源：本机可读取的 Claude Code 与 Codex 日志。其他设备与缺失日志不在统计范围内。',
  report: '在项目目录打开终端。先预览将要发送的内容，确认后运行上报命令，随后刷新本页。',
  footer: '本机验证版 · 尚未公开上线', script: 'report-usage.mjs',
  empty: '先预览本机统计，确认后主动上报。上报成功后，你和正在做的作品会出现在这里。',
  saved: '本机汇总', notSaved: '尚未上报 · 数据保存在本机',
  unavailable: '本机服务暂时无法提供数据。',
  invalid: '服务返回的内容不是有效的周榜数据，请确认本机服务仍在运行。',
  incomplete: '周榜数据格式不完整，请刷新或重新运行本机服务。',
  retry: '请确认本机服务仍在运行，然后重新读取。',
};
const integerFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const safeNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const fullNumber = (value) => integerFormatter.format(safeNumber(value));
const setText = (selector, value) => { $(selector).textContent = value; };
function compactNumber(value) {
  const amount = safeNumber(value);
  if (amount >= 100000000) return { number: (amount / 100000000).toFixed(2), unit: '亿 tokens' };
  if (amount >= 10000) return { number: (amount / 10000).toFixed(2), unit: '万 tokens' };
  return { number: fullNumber(amount), unit: 'tokens' };
}
function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function localDate(date) { return new Date(`${date}T00:00:00Z`); }
function addDays(date, count) { const value = localDate(date); value.setUTCDate(value.getUTCDate() + count); return value.toISOString().slice(0, 10); }
function monthDay(date) { const parts = date.split('-'); return `${Number(parts[1])}.${Number(parts[2])}`; }
function isDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(localDate(value).valueOf()); }
function safeLink(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/[\u0000-\u0020\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  }
  catch { return null; }
}
function costLabel(estimate) {
  if (!estimate) return '暂不能估算';
  const min = typeof estimate.min === 'number' && Number.isFinite(estimate.min) && estimate.min >= 0 ? estimate.min : null;
  const max = typeof estimate.max === 'number' && Number.isFinite(estimate.max) && estimate.max >= 0 ? estimate.max : null;
  if (min === null || max === null) return '暂不能估算';
  if (Math.abs(max - min) < 0.005) return currencyFormatter.format(min);
  return `${currencyFormatter.format(min)}–${currencyFormatter.format(max)}`;
}
function sumRows(rows) {
  const totals = Object.fromEntries(FIELDS.map((key) => [key, 0]));
  for (const row of rows) for (const key of FIELDS) totals[key] += safeNumber(row[key]);
  return totals;
}
function renderBoard(data) {
  const container = $('#leaderboard-rows'); container.replaceChildren();
  const rows = Array.isArray(data.rows) ? data.rows : [];
  $('#empty-state').hidden = rows.length > 0;
  setText('#empty-title', data.week.is_current ? '这一周，等你留下第一笔。' : '这一周，还没有保存的快照。');
  setText('#empty-description', data.week.is_current ? view.empty : '历史周只展示已保存的上报快照。当前命令默认处理本周，可回到本周先预览、再主动上报。');
  for (const row of rows) {
    const article = make('article', 'leaderboard-row');
    article.append(make('span', 'rank', String(row.rank ?? 1).padStart(2, '0')));
    const identity = make('div', 'creator');
    identity.append(make('span', 'creator-avatar', Array.from(String(row.nickname || '我'))[0]));
    const creatorText = make('div', 'creator-text'); const title = make('div', 'creator-title');
    title.append(make('strong', '', row.nickname || '未命名创作者'));
    if (row.city) title.append(make('span', 'city-badge', row.city));
    creatorText.append(title, make('p', '', row.project_name || '正在创造自己的作品'));
    identity.append(creatorText); article.append(identity);
    const tools = make('div', 'row-tools'); const toolList = Array.isArray(row.tools) ? row.tools : [];
    for (const tool of toolList) tools.append(make('span', 'tool-chip', tool));
    if (!toolList.length) tools.append(make('span', 'muted', '暂无用量'));
    article.append(tools);
    const tokenCell = make('div', 'row-total');
    tokenCell.append(make('strong', '', fullNumber(row.total_tokens)), make('span', '', 'tokens'));
    article.append(tokenCell); container.append(article);
  }
}
function renderProject(data) {
  const row = Array.isArray(data.rows) ? data.rows[0] : null; const profile = row || data.profile || {};
  setText('#project-owner', profile.nickname ? `${profile.nickname} · 正在做` : '我的作品');
  setText('#project-name', profile.project_name || '还没有填写作品');
  setText('#project-description', profile.project_description || '让本周的投入，和正在创造的东西连在一起。');
  const link = $('#project-link'); const href = safeLink(profile.project_url); link.hidden = !href;
  if (href) link.href = href; else link.removeAttribute('href');
}
function renderChart(rows, week) {
  const chart = $('#daily-chart'); chart.replaceChildren();
  const days = Array.from({ length: 7 }, (_, index) => ({ date: addDays(week.start, index), total: 0 }));
  const dayMap = new Map(days.map((day) => [day.date, day]));
  for (const row of rows) if (dayMap.has(row.date)) dayMap.get(row.date).total += safeNumber(row.total_tokens);
  const max = Math.max(1, ...days.map((day) => day.total)); const weekDays = ['一', '二', '三', '四', '五', '六', '日'];
  for (let index = 0; index < days.length; index += 1) {
    const day = days[index]; const column = make('div', 'chart-column');
    column.setAttribute('aria-label', `${day.date}，${fullNumber(day.total)} tokens`);
    column.title = `${day.date} · ${fullNumber(day.total)} tokens`;
    const compact = compactNumber(day.total);
    column.append(make('span', 'chart-value', day.total ? compact.number + compact.unit.replace(' tokens', '').replace('tokens', '') : '0'));
    const track = make('div', 'chart-track'); const bar = make('div', `chart-bar${day.total ? '' : ' zero'}`);
    bar.style.height = `${day.total ? Math.max(3, (day.total / max) * 100) : 2}%`; track.append(bar);
    column.append(track, make('span', 'chart-day', `周${weekDays[index]}`), make('span', 'chart-date', monthDay(day.date))); chart.append(column);
  }
  const activeDays = days.filter((day) => day.total > 0).length; const total = days.reduce((value, day) => value + day.total, 0);
  const period = week.is_current ? '本周' : '该周';
  setText('#chart-caption', total ? `${period}已记录 ${activeDays} 天，共 ${fullNumber(total)} tokens。` : `${period}还没有可显示的已上报用量。`);
}
function renderModels(rows) {
  const container = $('#model-list'); container.replaceChildren(); const groups = new Map();
  for (const row of rows) {
    const model = typeof row.model === 'string' && row.model.trim() && row.model !== 'unknown' ? row.model : '未知模型';
    const tool = typeof row.tool === 'string' && row.tool.trim() ? row.tool : '未知工具'; const key = JSON.stringify([tool, model]);
    if (!groups.has(key)) groups.set(key, { model, tool, total: 0 });
    groups.get(key).total += safeNumber(row.total_tokens);
  }
  const models = [...groups.values()].sort((a, b) => b.total - a.total); const grandTotal = models.reduce((value, model) => value + model.total, 0);
  setText('#model-count', `${models.length} 个模型记录`);
  if (!models.length) { container.append(make('p', 'models-empty', '上报后，在这里查看各模型的用量。')); return; }
  for (const model of models) {
    const item = make('div', 'model-item'); const heading = make('div', 'model-heading'); const identity = make('div', 'model-identity');
    identity.append(make('strong', '', model.model), make('span', '', model.tool)); heading.append(identity, make('span', 'model-total', fullNumber(model.total)));
    const track = make('div', 'model-track'); const fill = make('div', 'model-fill'); fill.style.width = `${grandTotal ? (model.total / grandTotal) * 100 : 0}%`;
    track.append(fill); item.append(heading, track); container.append(item);
  }
}
function renderDetails() {
  if (!state.data) return;
  const rows = state.data.daily.filter((row) => state.tool === 'all' || row.tool === state.tool); const totals = sumRows(rows);
  setText('#detail-input', fullNumber(totals.input_tokens)); setText('#detail-output', fullNumber(totals.output_tokens));
  setText('#detail-write', fullNumber(totals.cache_creation_input_tokens)); setText('#detail-read', fullNumber(totals.cache_read_input_tokens));
  setText('#filter-caption', state.tool === 'all' ? '下方明细包含两个工具；筛选不会改变上方周榜。' : `下方只显示 ${state.tool} 明细；上方周榜仍为全部工具用量。`);
  renderChart(rows, state.data.week); renderModels(rows);
}
function render(data) {
  state.data = data; const totals = data.totals || {}; const total = compactNumber(totals.total_tokens);
  setText('#week-range', `${monthDay(data.week.start)} — ${monthDay(data.week.end)}`);
  $('#week-range').title = `${data.week.start} 至 ${data.week.end} · 北京时间`;
  setText('#total-caption', data.week.is_current ? '本周 token 用量' : '该周 token 用量'); setText('#total-tokens', total.number);
  $('#total-tokens').title = `${fullNumber(totals.total_tokens)} tokens`; setText('#total-unit', total.unit);
  setText('#week-status', data.week.is_current ? '本周未结束' : '该周已结束');
  setText('#without-cache', `${fullNumber(totals.total_without_cache_read_tokens)} tokens`); setText('#participant-count', fullNumber(data.participant_count));
  setText('#cost-estimate', costLabel(data.estimate)); let detail = '按公开 API 价格估算，不是实际账单。';
  if (data.estimate) {
    if (safeNumber(data.estimate.unpriced_tokens)) detail = `仅已知模型参考估算，不是实际账单。另有 ${fullNumber(data.estimate.unpriced_tokens)} tokens 无对应价格，未计入。`;
    if (typeof data.estimate.label === 'string' && data.estimate.label) detail += ` ${data.estimate.label}`;
  }
  if (data.pricing_checked_at) detail += ` 价格核对：${data.pricing_checked_at}。`; setText('#cost-detail', detail);
  const timestamp = data.updated_at ? new Date(data.updated_at) : null;
  setText('#update-status', timestamp && !Number.isNaN(timestamp.valueOf()) ? `最近上报 ${dateTimeFormatter.format(timestamp)} · 北京时间 · ${view.saved}` : view.notSaved);
  const diagnostics = data.diagnostics && typeof data.diagnostics === 'object' ? Object.entries(data.diagnostics).filter(([, value]) => safeNumber(value) > 0) : [];
  const diagnosticList = $('#diagnostics-list'); diagnosticList.replaceChildren();
  for (const [category, count] of diagnostics) diagnosticList.append(make('li', '', `${category}：${fullNumber(count)}`));
  $('#diagnostics-note').hidden = diagnostics.length === 0;
  $('#current-week').disabled = Boolean(data.week.is_current); renderBoard(data); renderProject(data); renderDetails();
}
function setPending(pending) {
  state.pending = pending; $('#overview').setAttribute('aria-busy', String(pending)); $('#previous-week').disabled = pending || !state.data;
  $('#current-week').disabled = pending || Boolean(state.data?.week.is_current); $('#refresh-button').disabled = pending; $('#retry-button').disabled = pending;
}
async function loadWeek(start) {
  if (state.pending) return; setPending(true);
  try {
    const url = new URL('api/leaderboard', API_BASE);
    if (start) url.searchParams.set('week', start);
    const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'omit' }); let data;
    try { data = await response.json(); } catch { throw new Error(view.invalid); }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : view.unavailable);
    if (!data.week || !isDate(data.week.start) || !isDate(data.week.end) || !Array.isArray(data.daily) || !Array.isArray(data.rows)) throw new Error(view.incomplete);
    render(data); $('#error-banner').hidden = true;
  } catch (error) {
    setText('#error-message', error instanceof Error && !/^(?:Failed to fetch|Load failed|NetworkError)/i.test(error.message) ? error.message : view.retry); $('#error-banner').hidden = false;
    if (!state.data) { setText('#week-range', '暂未读取'); setText('#week-status', '读取失败'); setText('#update-status', view.retry); setText('#cost-detail', '数据读取成功后显示参考估算。'); }
  } finally { setPending(false); }
}
$('#previous-week').addEventListener('click', () => { if (state.data) loadWeek(addDays(state.data.week.start, -7)); });
$('#current-week').addEventListener('click', () => loadWeek());
$('#refresh-button').addEventListener('click', () => loadWeek(state.data?.week.start)); $('#retry-button').addEventListener('click', () => loadWeek(state.data?.week.start));
for (const button of document.querySelectorAll('[data-tool]')) button.addEventListener('click', () => {
  state.tool = button.dataset.tool;
  for (const item of document.querySelectorAll('[data-tool]')) { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); }
  renderDetails();
});
for (const button of document.querySelectorAll('[data-command]')) button.addEventListener('click', async () => {
  const command = $(`#${button.dataset.command}-command`).textContent;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持自动复制'); await navigator.clipboard.writeText(command);
    setText('#copy-feedback', '已复制。请到项目目录的终端粘贴运行。');
  } catch {
    const range = document.createRange(); range.selectNodeContents($(`#${button.dataset.command}-command`));
    const selection = window.getSelection();
    if (selection) { selection.removeAllRanges(); selection.addRange(range); }
    setText('#copy-feedback', '自动复制未成功，命令已选中。电脑可按 Ctrl+C（Mac 按 ⌘C），手机可长按复制。');
  }
});
function applyMode() {
  document.title = `有酸奶 Yak Yogurt · ${view.title}`;
  setText('#mode-label', view.badge);
  setText('#board-title', view.title);
  setText('#update-status', view.loading);
  setText('#scope-note', view.scope);
  setText('#report-description', view.report);
  setText('#mode-footer', view.footer);
  setText('#preview-command', `node scripts/${view.script} --preview`);
  setText('#submit-command', `node scripts/${view.script} --submit`);
  if (isPublic) setText('#command-note', '仅已配置上报的电脑可提交。命令默认处理本周；每次上报更新该周数据，重复运行不会累加。刷新网页只读取云端已保存的汇总。');
}
applyMode();
loadWeek();
