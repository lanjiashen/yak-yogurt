#!/usr/bin/env node
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { collectUsage, formatTable } from './count-usage.mjs';
import { DEFAULT_DATA_DIR, validateEndpoint } from '../lib/local-store.mjs';
import { FIELDS, weekFor, daysSince, sumUsage } from '../lib/week.mjs';
import { estimateUsage, PRICING_CHECKED_AT } from '../lib/pricing.mjs';

export function parseReportArgs(args) {
  const allowed = new Set(['--preview','--submit','--json','--yes','--allow-incomplete']);
  if (args.some(arg => !allowed.has(arg)) || new Set(args).size !== args.length ||
      (args.includes('--preview') && args.includes('--submit')) ||
      (!args.includes('--submit') && (args.includes('--yes') || args.includes('--allow-incomplete')))) {
    throw new Error('用法：node scripts/report-usage.mjs [--preview | --submit] [--json] [--yes] [--allow-incomplete]');
  }
  return { submit:args.includes('--submit'),json:args.includes('--json'),
    yes:args.includes('--yes'),allowIncomplete:args.includes('--allow-incomplete') };
}
export async function buildPreview({ now = new Date(), home = os.homedir(), ...roots } = {}) {
  const week = weekFor(now);
  const { report,diagnostics } = await collectUsage({ ...roots,home,now,days:daysSince(week.start,now),includeModels:true });
  const rows = report.by_model_daily.map(row => Object.fromEntries(['date','tool','model',...FIELDS].map(k => [k,row[k]])));
  const totals = sumUsage(rows);
  // 模型归属的添加不能改变原统计数字，任何不一致都停止。
  const original = report.totals.find(row => row.tool === '合计');
  for (const key of [...FIELDS,'total_tokens','total_without_cache_read_tokens']) {
    if (totals[key] !== original[key]) throw new Error('模型明细与工具合计不一致，已停止上报。');
  }
  return { schema_version:1,week,collected_at:now.toISOString(),rows,diagnostics,totals,
    tool_report:{ daily:report.daily,totals:report.totals },
    estimate:estimateUsage(rows),pricing_checked_at:PRICING_CHECKED_AT };
}
export async function sendPreview(preview,client,{ allowIncomplete = false } = {}) {
  const endpoint = validateEndpoint(client.endpoint);
  if (typeof client.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(client.token) ||
      typeof client.source_id !== 'string') throw new Error('本机上报配置无效，请先启动本机周榜。');
  if (Object.keys(preview.diagnostics).length && !allowIncomplete) {
    throw new Error('有日志未计入。先核对预览；接受不完整统计时才加 --allow-incomplete。');
  }
  const payload = { schema_version:1,source_id:client.source_id,week_start:preview.week.start,
    collected_at:preview.collected_at,rows:preview.rows,diagnostics:preview.diagnostics };
  const body = Buffer.from(JSON.stringify(payload));
  if (body.length > 1024 * 1024) throw new Error('汇总数据过大，已停止上报。');
  return new Promise((resolve,reject) => {
    const req = http.request(new URL('/api/usage',endpoint),{
      method:'POST',headers:{ Authorization:'Bearer ' + client.token,
        'Content-Type':'application/json','Content-Length':body.length },
      timeout:10000,
    },res => {
      let bytes = 0, chunks = [];
      res.on('data',chunk => {
        bytes += chunk.length;
        if (bytes > 65536) { res.destroy(); reject(new Error('本机回复过大。')); }
        else chunks.push(chunk);
      });
      res.on('error',() => reject(new Error('本机回复中断，请重新核对榜单。')));
      res.on('end',() => {
        if (res.statusCode !== 200) {
          const hints = { 401:'密钥已失效或撤销。',409:'这份预览已过时，请重新运行。',403:'只允许本机连接。' };
          return reject(new Error('上报失败（HTTP ' + res.statusCode + '）。' + (hints[res.statusCode] ?? '')));
        }
        try {
          const receipt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (receipt.ok !== true || receipt.total_tokens !== preview.totals.total_tokens ||
              receipt.week_start !== preview.week.start) throw new Error();
          resolve(receipt);
        } catch { reject(new Error('本机收据与预览不一致，请检查榜单。')); }
      });
    });
    req.on('timeout',() => { req.destroy(); reject(new Error('本机上报超时，请确认周榜窗口仍在运行。')); });
    req.on('error',() => reject(new Error('无法连接本机周榜，请先运行 npm start。')));
    req.end(body); // node:http仅连接显式127.0.0.1，不使用环境代理，也不跟随重定向。
  });
}
function printPreview(preview) {
  console.log('有酸奶 Yak Yogurt｜发送前预览');
  console.log('北京时间自然周：' + preview.week.start + ' 至 ' + preview.week.end + '（本周尚未结束）');
  console.log('采集时刻：' + preview.collected_at + '；仅此电脑可读取的日志');
  console.log(formatTable(preview.tool_report));
  console.log('\n模型明细（仅模型标识和汇总数字）：');
  const models = new Map();
  for (const row of preview.rows) {
    const key = row.tool + ' / ' + row.model;
    models.set(key,(models.get(key) ?? 0) + FIELDS.reduce((sum,k) => sum + row[k],0));
  }
  for (const [model,total] of models) console.log(model + '：' + total.toLocaleString('en-US'));
  const e = preview.estimate;
  console.log('参考费用：' + (e.min == null ? '未计价' : '$' + e.min.toFixed(4) + '—$' + e.max.toFixed(4)) +
    '；未计价用量 ' + e.unpriced_tokens.toLocaleString('en-US') + ' tokens。');
  console.log('费用只是官方标准API参考区间，不是订阅账单；不含Fast/地域/工具等费用。');
  for (const [kind,n] of Object.entries(preview.diagnostics)) console.error(kind + '：' + n);
}
async function main() {
  const args = parseReportArgs(process.argv.slice(2));
  const preview = await buildPreview();
  if (!args.json) printPreview(preview);
  if (!args.submit) {
    if (args.json) console.log(JSON.stringify(preview,null,2));
    else console.log('\n当前只预览，未联网、未保存上报数据。确认后运行 node scripts/report-usage.mjs --submit');
    return;
  }
  if (!args.yes) {
    if (args.json || !process.stdin.isTTY) throw new Error('非交互上报请显式加 --yes；默认预览不会上报。');
    const prompt = createInterface({ input:process.stdin,output:process.stdout });
    let answer;
    try { answer = await prompt.question('是否将上述汇总数字上报到本机？[y/N] '); } finally { prompt.close(); }
    if (!['y','yes'].includes(answer.trim().toLowerCase())) { console.log('已取消，没有上报。'); return; }
  }
  let client;
  try { client = JSON.parse(await readFile(path.join(DEFAULT_DATA_DIR,'client.json'),'utf8')); }
  catch { throw new Error('请先运行 npm start，生成本机密钥并启动周榜。'); }
  const receipt = await sendPreview(preview,client,args);
  if (args.json) console.log(JSON.stringify({ preview,receipt },null,2));
  else {
    console.log('\n上报成功：' + (receipt.changed ? '本周记录已更新' : '数字未变，没有重复累加') + '。');
    console.log('网页总计：' + receipt.total_tokens.toLocaleString('en-US') + ' tokens。打开 ' + validateEndpoint(client.endpoint));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
