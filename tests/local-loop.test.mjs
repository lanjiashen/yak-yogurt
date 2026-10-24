import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startLocalServer } from '../scripts/local-server.mjs';
import { buildPreview, sendPreview, parseReportArgs } from '../scripts/report-usage.mjs';
import { createRepository, validateSubmission, validateEndpoint } from '../lib/local-store.mjs';
import { weekFor, daysSince, sumUsage } from '../lib/week.mjs';
import { estimateUsage } from '../lib/pricing.mjs';
const NOW = new Date('2026-10-24T04:00:00.000Z');
const usage = (n=100) => ({ input_tokens:n,output_tokens:20,cache_creation_input_tokens:10,cache_read_input_tokens:50 });
async function setup(t,{ realTime=false } = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(tempRoot,'yak-local-loop-'));
  const dataDir = path.join(root,'runtime');
  const running = await startLocalServer({ port:0,dataDir,now:realTime ? () => new Date() : () => NOW });
  t.after(async () => {
    await new Promise(resolve => { running.server.close(resolve); running.server.closeAllConnections(); });
    assert.equal(path.dirname(path.resolve(root)),tempRoot);
    assert.equal(path.basename(root).startsWith('yak-local-loop-'),true);
    await rm(root,{ recursive:true,force:true });
  });
  const client = JSON.parse(await readFile(running.repo.files.client,'utf8'));
  const payload = (options={}) => ({
    schema_version:1,source_id:client.source_id,week_start:'2026-10-19',collected_at:'2026-10-24T03:00:00.000Z',
    rows:[{ date:'2026-10-23',tool:'Claude Code',model:'claude-opus-5-5',...usage() }],diagnostics:{},...options,
  });
  const post = async (body,token=client.token,headers={}) => {
    const res = await fetch(running.url + '/api/usage',{ method:'POST',
      headers:{ Authorization:'Bearer ' + token,'Content-Type':'application/json',...headers },body:JSON.stringify(body) });
    return { status:res.status,body:await res.json() };
  };
  return { root,dataDir,...running,client,payload,post };
}
test('北京时间周界、跨月与当前周天数独立于系统时区',() => {
  assert.deepEqual(weekFor(new Date('2026-10-25T15:59:59Z')),{ start:'2026-10-19',end:'2026-10-25',timezone:'Asia/Shanghai' });
  assert.equal(weekFor(new Date('2026-10-25T16:00:00Z')).start,'2026-10-26');
  assert.equal(weekFor('2026-11-01').start,'2026-10-26');
  assert.equal(daysSince('2026-10-19',NOW),6);
  assert.throws(() => weekFor('2026-02-30'));
});
test('价格仅匹配精确模型；未知量不当作零费用，缓存时长给区间',() => {
  const estimate = estimateUsage([{ model:'claude-opus-5-5',...usage(1000000),cache_creation_input_tokens:1000000 },
    { model:'custom-secret-model',...usage(100) }]);
  assert.equal(estimate.covered_tokens,2000070);
  assert.equal(estimate.unpriced_tokens,180);
  assert.ok(Math.abs(estimate.min - 9.00041) < 1e-9);
  assert.ok(Math.abs(estimate.max - 12.00041) < 1e-9);
  assert.equal(estimateUsage([{ model:'unknown',...usage() }]).min,null);
});
test('OpenAI未知单次上下文按短至长标准价区间，不按周总数触发一档',() => {
  const e = estimateUsage([{ model:'gpt-6.1-sol',input_tokens:1000000,output_tokens:1000000,cache_creation_input_tokens:0,cache_read_input_tokens:1000000 }]);
  assert.equal(e.min,12.1); assert.equal(e.max,19.2);
  const partial = estimateUsage([{ model:'gpt-5.6-luna',input_tokens:10,output_tokens:0,cache_creation_input_tokens:7,cache_read_input_tokens:0 }]);
  assert.equal(partial.unpriced_tokens,7); assert.equal(partial.covered_tokens,10);
});
test('验证拒绝原始日志/未知字段、重复行、无效日期与超限数字',() => {
  const source='fake-source';
  const base = { schema_version:1,source_id:source,week_start:'2026-10-19',collected_at:'2026-10-24T03:00:00.000Z',
    rows:[{ date:'2026-10-23',tool:'Codex',model:'unknown',...usage() }],diagnostics:{} };
  assert.equal(validateSubmission(base,source,NOW).rows.length,1);
  assert.deepEqual(validateSubmission({ ...base,diagnostics:{ 'Codex｜继承用量来源待核':1 } },source,NOW).diagnostics,
    { 'Codex｜继承用量来源待核':1 });
  for (const payload of [
    { ...base,content:'PRIVATE_BODY' },{ ...base,rows:[{ ...base.rows[0],content:'PRIVATE_BODY' }] },
    { ...base,rows:[base.rows[0],base.rows[0]] },{ ...base,week_start:'2026-10-20' },
    { ...base,rows:[{ ...base.rows[0],date:'2026-10-25' }] },
    { ...base,rows:[{ ...base.rows[0],input_tokens:-1 }] },
    { ...base,rows:[{ ...base.rows[0],input_tokens:Number.MAX_SAFE_INTEGER }] },
    { ...base,rows:[{ ...base.rows[0],model:'../../private' }] },{ ...base,source_id:'other' },
    { ...base,diagnostics:{ 'PRIVATE_BODY':1 } },{ ...base,collected_at:'2026-10-26T03:00:00.000Z' },
  ]) assert.throws(() => validateSubmission(payload,source,NOW));
});
test('上报、重复、修正、整周替换与上一版备份按预期工作',async t => {
  const s=await setup(t), first=s.payload();
  const a=await s.post(first); assert.equal(a.status,200); assert.equal(a.body.total_tokens,180); assert.equal(a.body.changed,true);
  const b=await s.post(first); assert.equal(b.body.total_tokens,180); assert.equal(b.body.changed,false);
  const changed=s.payload({ collected_at:'2026-10-24T03:01:00.000Z',rows:[{ ...first.rows[0],input_tokens:5,model:'claude-sonnet-5-5' }] });
  assert.equal((await s.post(changed)).body.total_tokens,85);
  const board=await (await fetch(s.url+'/api/leaderboard')).json();
  assert.equal(board.totals.total_tokens,85); assert.equal(board.participant_count,1);
  assert.equal(board.daily.length,1); assert.equal(board.daily[0].model,'claude-sonnet-5-5');
  const backup=JSON.parse(await readFile(s.repo.files.data+'.bak','utf8'));
  assert.equal(sumUsage(backup.weeks['2026-10-19'].rows).total_tokens,180);
});
test('服务重启读取原数据；旧快照不能覆盖较新记录；历史周隔离',async t => {
  const s=await setup(t);
  await s.post(s.payload());
  assert.equal((await s.post(s.payload({ collected_at:'2026-10-24T02:59:00.000Z' }))).status,409);
  const historical=s.payload({ week_start:'2026-10-12',collected_at:'2026-10-18T03:00:00.000Z',
    rows:[{ date:'2026-10-18',tool:'Codex',model:'gpt-6-luna',...usage(5) }] });
  assert.equal((await s.post(historical)).status,200);
  await new Promise(resolve => { s.server.close(resolve); s.server.closeAllConnections(); });
  const restarted=await startLocalServer({ port:0,dataDir:s.dataDir,now:() => NOW });
  t.after(async () => { await new Promise(resolve => { restarted.server.close(resolve); restarted.server.closeAllConnections(); }); });
  const current=await (await fetch(restarted.url+'/api/leaderboard')).json();
  const old=await (await fetch(restarted.url+'/api/leaderboard?week=2026-10-12')).json();
  assert.equal(current.totals.total_tokens,180); assert.equal(old.totals.total_tokens,85);
  assert.equal(old.week.is_current,false);
});
test('错误密钥与撤销密钥均拒绝，更换后新密钥可用且旧密钥继续失效',async t => {
  const s=await setup(t);
  assert.equal((await s.post(s.payload(),'wrong-key')).status,401);
  await s.repo.revokeKey(); assert.equal((await s.post(s.payload())).status,401);
  await s.repo.rotateKey();
  assert.equal((await s.post(s.payload())).status,401);
  const client=JSON.parse(await readFile(s.repo.files.client,'utf8'));
  assert.notEqual(client.token,s.client.token);
  assert.equal((await s.post(s.payload(),client.token)).status,200);
  const text=JSON.stringify(await (await fetch(s.url+'/api/leaderboard')).json());
  assert.equal(text.includes(client.token),false); assert.equal(text.includes(s.client.token),false);
});
test('拒绝外部Origin、伪造Host与任意文件；页面接口没有凭据和原始ID',async t => {
  const s=await setup(t);
  assert.equal((await fetch(s.url+'/api/leaderboard',{ headers:{ Origin:'https://elsewhere.invalid' } })).status,403);
  const status=await new Promise((resolve,reject) => {
    const req=http.get(s.url+'/api/leaderboard',{ headers:{ Host:'attacker.invalid' } },res => { res.resume();resolve(res.statusCode); });
    req.on('error',reject);
  });
  assert.equal(status,403);
  for (const route of ['/.runtime/client.json','/lib/local-store.mjs','/CODEX-LOG.md','/api/leaderboard?week=2026-10-20']) {
    assert.ok([400,404].includes((await fetch(s.url+route)).status));
  }
  await s.post(s.payload());
  const text=await (await fetch(s.url+'/api/leaderboard')).text();
  for (const privateValue of [s.client.token,s.client.source_id,s.root,'token_hash']) assert.equal(text.includes(privateValue),false);
});
test('并发写串行持久化，诊断只保留枚举计数，恶意作品链接被拒',async t => {
  const s=await setup(t);
  const payload=s.payload({ diagnostics:{ 'Claude Code｜无法解析的记录':2 } });
  const results=await Promise.all([s.post(payload),s.post(payload)]);
  assert.equal(results.filter(r => r.body.changed).length,1);
  assert.deepEqual((await s.repo.leaderboard()).diagnostics,{ 'Claude Code｜无法解析的记录':2 });
  const board=await s.repo.leaderboard();
  await assert.rejects(s.repo.updateProfile({ ...board.profile,project_url:'javascript:alert(1)' }));
  assert.equal((await s.repo.leaderboard()).profile.project_url,board.profile.project_url);
});
test('损坏数据不被自动清空或覆盖',async t => {
  const s=await setup(t);
  await writeFile(s.repo.files.data,'BROKEN_DATA');
  assert.equal((await fetch(s.url+'/api/leaderboard')).status,500);
  assert.equal((await s.post(s.payload())).status,500);
  assert.equal(await readFile(s.repo.files.data,'utf8'),'BROKEN_DATA');
});
test('命令行默认预览；非本机地址和带凭据/路径的地址均拒绝',() => {
  assert.equal(parseReportArgs([]).submit,false); assert.equal(parseReportArgs(['--submit','--yes']).submit,true);
  for (const args of [['--preview','--submit'],['--yes'],['--submit','--submit'],['--unknown']]) assert.throws(() => parseReportArgs(args));
  for (const value of ['https://example.com','http://localhost:8796','http://127.0.0.1:8796/x','http://user:pass@127.0.0.1:8796','http://127.0.0.1:8796?secret=x']) assert.throws(() => validateEndpoint(value));
  assert.equal(validateEndpoint('http://127.0.0.1:8796'),'http://127.0.0.1:8796');
});
async function fakeHome(root) {
  const home=path.join(root,'home'),timestamp=new Date(Date.now()-2000).toISOString();
  const files=[
    [path.join(home,'.claude','projects','sample','usage.jsonl'),[{ type:'assistant',timestamp,
      message:{ id:'PRIVATE_MESSAGE_ID',model:'claude-opus-5-5',content:'PRIVATE_BODY',
        usage:usage(11) } }]],
    [path.join(home,'.codex','sessions','sample','usage.jsonl'),[
      { type:'session_meta',payload:{ id:'PRIVATE_SESSION_ID' } },
      { type:'turn_context',payload:{ model:'gpt-6.1-sol',developer_instructions:'PRIVATE_BODY' } },
      { type:'event_msg',timestamp,payload:{ type:'token_count',info:{
        total_token_usage:{ input_tokens:40,output_tokens:9,cached_input_tokens:23 },
        last_token_usage:{ input_tokens:40,output_tokens:9,cached_input_tokens:23 },
      } } },
    ]],
  ];
  for (const [name,records] of files) {
    await mkdir(path.dirname(name),{ recursive:true }); await writeFile(name,records.map(r => JSON.stringify(r)).join('\n')+'\n');
  }
  return home;
}
function runCli(args,env,cwd) {
  return new Promise((resolve,reject) => {
    const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/report-usage.mjs',import.meta.url)),...args],{
      env:{ ...process.env,...env },cwd,stdio:['ignore','pipe','pipe'],
    });
    let stdout='',stderr='';
    const timer=setTimeout(() => { child.kill();reject(new Error('CLI test timed out')); },15000);
    child.stdout.on('data',chunk => { stdout+=chunk; }); child.stderr.on('data',chunk => { stderr+=chunk; });
    child.on('error',reject); child.on('close',code => { clearTimeout(timer); resolve({ code,stdout,stderr }); });
  });
}
test('真实CLI预览到HTTP到网页完整往返；预览不保存、发送不泄露日志或密钥',async t => {
  const s=await setup(t,{ realTime:true }),home=await fakeHome(s.root);
  const env={ HOME:home,USERPROFILE:home,YAK_YOGURT_DATA_DIR:s.dataDir,TZ:'America/Los_Angeles',
    HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1' };
  const first=await runCli(['--preview','--json'],env,home);
  assert.equal(first.code,0,first.stderr);
  const preview=JSON.parse(first.stdout);
  assert.equal(preview.totals.total_tokens,140); assert.equal((await s.repo.leaderboard()).participant_count,0);
  const sent=await runCli(['--submit','--yes','--json'],env,home);
  assert.equal(sent.code,0,sent.stderr);
  const result=JSON.parse(sent.stdout);
  assert.equal(result.receipt.total_tokens,result.preview.totals.total_tokens);
  assert.equal((await s.repo.leaderboard()).totals.total_tokens,140);
  const again=await runCli(['--submit','--yes','--json'],env,home);
  assert.equal(again.code,0,again.stderr); assert.equal(JSON.parse(again.stdout).receipt.changed,false);
  for (const secret of ['PRIVATE_BODY','PRIVATE_MESSAGE_ID','PRIVATE_SESSION_ID',s.client.token,home]) {
    assert.equal((sent.stdout+sent.stderr+await readFile(s.repo.files.data,'utf8')).includes(secret),false);
  }
});
test('预览无需服务或密钥且不生成运行目录；有缺失日志默认不能上报',async t => {
  const s=await setup(t),home=path.join(s.root,'missing-home'),dataDir=path.join(s.root,'not-created');
  await mkdir(home);
  const result=await runCli(['--preview','--json'],{ HOME:home,USERPROFILE:home,YAK_YOGURT_DATA_DIR:dataDir },home);
  assert.equal(result.code,0); assert.equal(JSON.parse(result.stdout).totals.total_tokens,0);
  await assert.rejects(stat(dataDir));
  const preview=await buildPreview({ now:NOW,home });
  await assert.rejects(sendPreview(preview,s.client),/有日志未计入/);
  const receipt=await sendPreview(preview,s.client,{ allowIncomplete:true });
  assert.equal(receipt.total_tokens,0);
});
test('上报客户端不跟随本机重定向',async t => {
  const s=await setup(t);
  const preview={ week:weekFor(NOW),collected_at:NOW.toISOString(),rows:[],diagnostics:{},totals:sumUsage([]) };
  const redirect=http.createServer((req,res) => { req.resume();res.writeHead(302,{ Location:'https://example.invalid/private' });res.end(); });
  await new Promise(resolve => redirect.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await new Promise(resolve => redirect.close(resolve)); });
  await assert.rejects(sendPreview(preview,{ ...s.client,endpoint:'http://127.0.0.1:'+redirect.address().port }),/HTTP 302/);
});

test('同目录的独立仓库实例并发更新资料与上报，不互相覆盖',async t => {
  const s=await setup(t),other=await createRepository({ dataDir:s.dataDir,now:() => NOW });
  const profile={ ...(await other.leaderboard()).profile,nickname:'并发资料' };
  await Promise.all([s.repo.submit(s.payload(),s.client.token),other.updateProfile(profile)]);
  const board=await s.repo.leaderboard();
  assert.equal(board.profile.nickname,'并发资料'); assert.equal(board.totals.total_tokens,180);
  assert.equal((await fetch(s.url+'/api/leaderboard?week=not-a-date')).status,400);
  assert.equal(estimateUsage([{ model:'constructor',...usage() }]).unpriced_tokens,180);
});
test('并行首次初始化只生成匹配的一组个人密钥',async t => {
  const s=await setup(t),newDir=path.join(s.root,'parallel-init');
  const repos=await Promise.all(Array.from({ length:4 },() => createRepository({ dataDir:newDir })));
  const client=JSON.parse(await readFile(path.join(newDir,'client.json'),'utf8'));
  for (const repo of repos) assert.equal(await repo.authenticate(client.token),true);
});
