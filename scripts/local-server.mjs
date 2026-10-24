#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRepository, DEFAULT_DATA_DIR, LocalError } from '../lib/local-store.mjs';

const ASSETS = new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/index.html', ['index.html','text/html; charset=utf-8']],
  ['/app.js', ['app.js','text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css','text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg','image/svg+xml']],
]);
const HEADERS = {
  'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
function json(res,status,body) {
  res.writeHead(status,{ ...HEADERS,'Content-Type':'application/json; charset=utf-8' }); res.end(JSON.stringify(body));
}
async function getBody(req) {
  let bytes = 0, chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new LocalError('上报过大，只接受汇总数字。',413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new LocalError('上报JSON格式无效。'); }
}
export async function startLocalServer({ port = 8796, dataDir = DEFAULT_DATA_DIR, now = () => new Date() } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new LocalError('端口无效。');
  const repo = await createRepository({ dataDir,now });
  const server = http.createServer(async (req,res) => {
    try {
      const actualPort = server.address().port;
      const host = req.headers.host;
      if (!['127.0.0.1:' + actualPort,'localhost:' + actualPort].includes(host) ||
          !['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw new LocalError('仅允许本机访问。',403);
      const origin = req.headers.origin;
      if (origin && !['http://127.0.0.1:' + actualPort,'http://localhost:' + actualPort].includes(origin)) throw new LocalError('拒绝其他网页发起的请求。',403);
      const url = new URL(req.url,'http://' + host);
      if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
        if ([...url.searchParams.keys()].some(key => key !== 'week') || url.searchParams.getAll('week').length > 1) throw new LocalError('查询参数无效。');
        return json(res,200,await repo.leaderboard(url.searchParams.get('week') || undefined));
      }
      if (req.method === 'POST' && url.pathname === '/api/usage') {
        if (url.search || req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new LocalError('只接受JSON汇总。',415);
        const auth = req.headers.authorization;
        if (!auth?.startsWith('Bearer ') || !await repo.authenticate(auth.slice(7))) throw new LocalError('上报密钥无效或已撤销。',401);
        return json(res,200,await repo.submit(await getBody(req),auth.slice(7)));
      }
      if (req.method === 'GET' && !url.search && ASSETS.has(url.pathname)) {
        const [name,type] = ASSETS.get(url.pathname);
        const body = await readFile(new URL('../web/' + name,import.meta.url));
        res.writeHead(200,{ ...HEADERS,'Content-Type':type }); return res.end(body);
      }
      throw new LocalError('没有这个本机页面或接口。',404);
    } catch (error) {
      if (!res.headersSent) json(res,error instanceof LocalError ? error.status : 500,
        { error: error instanceof LocalError ? error.message : '本机服务暂时无法完成操作，请保留数据并检查。' });
      else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.maxRequestsPerSocket = 100;
  await new Promise((resolve,reject) => {
    server.once('error',reject); server.listen(port,'127.0.0.1',resolve);
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  try { await repo.setEndpoint(url); } catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  return { server,repo,url };
}
async function main() {
  const args = process.argv.slice(2);
  let port = 8796;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--port' || !/^[1-9]\d*$/.test(args[1])) throw new Error('用法：node scripts/local-server.mjs [--port 8796]');
    port = Number(args[1]);
  }
  const { server,url } = await startLocalServer({ port });
  console.log('有酸奶 Yak Yogurt｜本机周榜已启动');
  console.log('打开 ' + url);
  console.log('先运行 node scripts/report-usage.mjs --preview；确认后加 --submit 主动上报。');
  console.log('本机密钥和数据保存在被Git忽略的.runtime中，不会打印密钥。按Ctrl+C停止。');
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.code === 'EADDRINUSE' ? '端口已被占用，请换一个本机端口。' : error.message); process.exitCode = 1; });
}
