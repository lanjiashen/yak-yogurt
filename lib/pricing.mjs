import { FIELDS } from './week.mjs';
export const PRICING_CHECKED_AT = '2026-10-24';
export const PRICING_SOURCES = [
  'https://developers.openai.com/api/docs/pricing',
  'https://platform.claude.com/docs/en/about-claude/pricing',
];
// 只匹配核验过的完整模型ID。数组依次为普通输入、输出、缓存写入低/高、缓存读取。
// maxContextPrice是上下文长度未知时的标准长上下文上界，不包含Fast/Batch/地域/工具费用。
export const PRICES = Object.freeze({
  'gpt-6.1-sol': { rates: [2, 10, [2.5, 5], .1], long: true },
  'gpt-6-luna': { rates: [.1, .5, [.125, .25], .01], long: true },
  'gpt-6-sol': { rates: [2, 10, [2.5, 5], .2], long: true },
  'gpt-5.6-sol': { rates: [4, 20, [5, 10], .4], long: false },
  'gpt-5.6-luna': { rates: [.2, 1.2, null, .02], long: false },
  'claude-opus-5-5': { rates: [4, 20, [5, 8], .2], long: false },
  'claude-sonnet-5-5': { rates: [2, 10, [2.5, 4], .1], long: false },
});
export function estimateUsage(rows) {
  let min = 0, max = 0, covered = 0, unpriced = 0;
  for (const row of rows) {
    const price = Object.hasOwn(PRICES,row.model) ? PRICES[row.model] : null;
    for (let i = 0; i < FIELDS.length; i++) {
      const n = row[FIELDS[i]];
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('计价用量无效。');
      const rate = price?.rates[i];
      if (rate == null) { unpriced += n; continue; }
      const [low, high] = Array.isArray(rate) ? rate : [rate, rate];
      min += n * low / 1e6;
      const multiplier = price.long ? (i === 1 ? 1.5 : 2) : 1;
      max += n * high * multiplier / 1e6;
      covered += n;
    }
  }
  if (![covered, unpriced].every(Number.isSafeInteger)) throw new Error('计价合计过大。');
  return { currency: 'USD', min: covered ? min : null, max: covered ? max : null,
    covered_tokens: covered, unpriced_tokens: unpriced,
    label: unpriced ? '仅已知模型的标准API参考区间；存在未计价用量' : '标准API参考区间，并非订阅账单' };
}
