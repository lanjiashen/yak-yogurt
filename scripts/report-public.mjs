#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { buildPreview } from './report-usage.mjs';
import { formatTable } from './count-usage.mjs';
import { FIELDS } from '../lib/week.mjs';
import { loadPublicClient, sendPublicPreview } from '../lib/public-client.mjs';

export function parsePublicReportArgs(argv) {
  const flags = new Set(['--preview', '--submit', '--json', '--yes', '--allow-incomplete']);
  const seen = new Set(); let config;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--config') {
      if (seen.has(arg) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('公开上报配置参数无效。');
      seen.add(arg); config = argv[++index];
    } else {
      if (!flags.has(arg) || seen.has(arg)) throw new Error('公开上报参数无效。');
      seen.add(arg);
    }
  }
  if ((seen.has('--preview') && seen.has('--submit')) ||
      (!seen.has('--submit') && (seen.has('--yes') || seen.has('--allow-incomplete')))) throw new Error('请先预览；确认上报时使用 --submit，可加 --yes 和 --allow-incomplete。');
  return { submit: seen.has('--submit'), json: seen.has('--json'), yes: seen.has('--yes'),
    allowIncomplete: seen.has('--allow-incomplete'), config };
}
function printPreview(preview, write, writeError) {
  write('有酸奶 Yak Yogurt｜公开 HTTPS 上报前预览');
  write('北京时间自然周：' + preview.week.start + ' 至 ' + preview.week.end + '（本周尚未结束）');
  write('采集时刻：' + preview.collected_at + '；仅此电脑可读取的日志');
  write(formatTable(preview.tool_report));
  write('模型明细（仅模型标识和汇总数字）：');
  const models = new Map();
  for (const row of preview.rows) {
    const key = row.tool + ' / ' + row.model;
    models.set(key, (models.get(key) ?? 0) + FIELDS.reduce((sum, field) => sum + row[field], 0));
  }
  for (const [model, total] of models) write(model + '：' + total.toLocaleString('en-US'));
  write('只发送日期、工具、模型和四类用量汇总，以及固定类别的诊断数量。');
  write('不发送提示词、回答、文件路径、原始会话标识或费用估算。');
  for (const [kind, count] of Object.entries(preview.diagnostics)) writeError(kind + '：' + count);
}
async function askConfirmation() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return await prompt.question('是否将上述汇总数字上报到已配置的独立 HTTPS 服务？[y/N] '); }
  finally { prompt.close(); }
}
export async function runPublicReport(argv, {
  makePreview = buildPreview, loadClient = loadPublicClient, send = sendPublicPreview,
  write = value => console.log(value), writeError = value => console.error(value),
  isTTY = process.stdin.isTTY, confirm = askConfirmation,
} = {}) {
  const args = parsePublicReportArgs(argv);
  const preview = await makePreview();
  if (!args.json) printPreview(preview, write, writeError);
  if (!args.submit) {
    if (args.json) write(JSON.stringify(preview, null, 2));
    else write('当前只预览，未读取公开上报配置、未联网。确认后使用 --submit。');
    return { preview };
  }
  if (!args.yes) {
    if (args.json || !isTTY) throw new Error('非交互公开上报请显式加 --yes；默认预览不会上报。');
    const answer = await confirm();
    if (!['y', 'yes'].includes(String(answer).trim().toLowerCase())) {
      write('已取消，没有公开上报。'); return { preview, cancelled: true };
    }
  }
  const client = await loadClient(args.config);
  const receipt = await send(preview, client, { allowIncomplete: args.allowIncomplete });
  if (args.json) write(JSON.stringify({ preview, receipt }, null, 2));
  else {
    write('公开 HTTPS 上报成功：' + (receipt.changed ? '本周记录已更新' : '数字未变，没有重复累加') + '。');
    write('已保存总计：' + receipt.total_tokens.toLocaleString('en-US') + ' tokens。');
  }
  return { preview, receipt };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPublicReport(process.argv.slice(2)).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
