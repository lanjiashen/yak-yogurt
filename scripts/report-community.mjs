#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parsePublicReportArgs,runPublicReport } from './report-public.mjs';
import { loadCommunityClient,sendCommunityPreview } from '../lib/community-client.mjs';

const HELP = '有酸奶 Yak Yogurt｜v2个人专属用量上报\n'+
  '用法：node scripts/report-community.mjs [--preview | --submit] [--json] [--yes] [--allow-incomplete] [--config 文件名]\n'+
  '默认只预览，不读取上报配置、不联网、不生成身份。\n'+
  '确认后使用 --submit；非交互上报还需 --yes。存在未计入日志时默认停止，核对后才使用 --allow-incomplete。\n'+
  'v2个人专属配置：先从个人中心下载，放在本工程 .runtime/public-client-v2.json；可使用同目录 public-client-v2-<安全名称>.json。\n'+
  '仅发送日期、工具、模型和用量汇总；请勿分享配置文件或其中的个人上报密钥。';
const usageError = () => new Error('参数无效。用法：node scripts/report-community.mjs [--preview | --submit] [--json] [--yes] [--allow-incomplete] [--config 文件名]；使用 --help 查看v2个人专属配置说明。');
export function parseCommunityReportArgs(argv) {
  try {
    if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw usageError();
    if (argv.length === 1 && argv[0] === '--help') return { help:true };
    return parsePublicReportArgs(argv);
  } catch { throw usageError(); }
}
async function askCommunityConfirmation() {
  const prompt = createInterface({ input:process.stdin,output:process.stdout });
  try { return await prompt.question('是否将上述汇总上报到有酸奶的v2个人周榜？[y/N] '); }
  finally { prompt.close(); }
}
export async function runCommunityReport(argv,{ loadClient = loadCommunityClient,send = sendCommunityPreview,
  write = value => console.log(value),confirm = askCommunityConfirmation,...options } = {}) {
  const args = parseCommunityReportArgs(argv);
  if (args.help) { write(HELP); return { help:true }; }
  const writeV2 = value => {
    if (value === '有酸奶 Yak Yogurt｜公开 HTTPS 上报前预览') {
      write('有酸奶 Yak Yogurt｜v2个人周榜上报前预览');
    } else if (value === '当前只预览，未读取公开上报配置、未联网。确认后使用 --submit。') {
      write('当前只预览，未读取v2个人专属配置、未联网。确认后运行 node scripts/report-community.mjs --submit。');
    } else { write(value); }
  };
  return runPublicReport(argv,{ ...options,loadClient,send,write:writeV2,confirm });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCommunityReport(process.argv.slice(2)).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
