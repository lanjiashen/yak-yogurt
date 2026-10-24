export const FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
export const TOOLS = ['Claude Code', 'Codex'];
const DAY = 86400000;
export function beijingDate(value = new Date()) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('日期无效。');
  return new Date(value.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
export function weekFor(value = new Date()) {
  const date = value instanceof Date ? beijingDate(value) : value;
  if (!validDate(date)) throw new Error('日期无效。');
  const time = Date.parse(date + 'T00:00:00Z');
  const offset = (new Date(time).getUTCDay() + 6) % 7;
  const startTime = time - offset * DAY;
  return { start: new Date(startTime).toISOString().slice(0, 10),
    end: new Date(startTime + 6 * DAY).toISOString().slice(0, 10), timezone: 'Asia/Shanghai' };
}
export function daysSince(start, now = new Date()) {
  if (!validDate(start)) throw new Error('日期无效。');
  return Math.round((Date.parse(beijingDate(now)) - Date.parse(start)) / DAY) + 1;
}
export function zeroUsage() { return Object.fromEntries(FIELDS.map(field => [field, 0])); }
export function finishUsage(row) {
  const total = FIELDS.reduce((sum, key) => sum + row[key], 0);
  if (!Number.isSafeInteger(total)) throw new Error('合计超出安全计数范围。');
  return { ...row, total_tokens: total, total_without_cache_read_tokens: total - row.cache_read_input_tokens };
}
export function sumUsage(rows) {
  const total = zeroUsage();
  for (const row of rows) for (const key of FIELDS) {
    total[key] += row[key];
    if (!Number.isSafeInteger(total[key])) throw new Error('合计超出安全计数范围。');
  }
  return finishUsage(total);
}
