// 임시 프로젝트로 환경 보존과 서버 실행 및 종료 동작을 검증합니다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { Engine, recipe } = require('./engine.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, script = 'cp ./env/.env.dev ./.env && node server.cjs') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-test-'));
  const project = path.join(root, 'project'); await fs.mkdir(path.join(project, 'env'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { 'start:dev': script, 'start:prod': 'cp ./env/.env.prod ./.env && node server.cjs' } }));
  await fs.writeFile(path.join(project, 'env/.env.dev'), 'API_URL="https://dev.example"\nTOKEN="base-token-private"\nMULTILINE="hello\nworld"\n');
  await fs.writeFile(path.join(project, 'env/.env.prod'), 'API_URL=https://prod.example\n');
  await fs.writeFile(path.join(project, '.env'), 'KEEP=unchanged\n');
  await fs.writeFile(path.join(project, 'server.cjs'), `const fs = require('fs'); fs.writeFileSync('observed.json', JSON.stringify({url:process.env.API_URL,multi:process.env.MULTILINE,token:process.env.TOKEN,pid:process.pid}));setInterval(()=>{},1000);`);
  const dataDir = path.join(root, 'data'); await fs.mkdir(dataDir); await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ groups: [], overrides: {} }));
  const engine = new Engine({ dataDir }); const group = await engine.addGroup('Test'); const app = await engine.addApp(group.id, { path: project });
  t.after(async () => { await engine.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  return { engine, app, root, project, dataDir };
}
async function observed(project) { for(let i=0;i<60;i++) { try { return JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8')); } catch { await delay(50); } } throw new Error('Child failed to start'); }
test('recognizes project environment wrappers and mode-dependent ports', () => {
  assert.deepEqual(recipe('cp ./env/.env.prod ./.env && vite --port 2023 --mode prod'), { command: 'vite --port 2023 --mode prod', file: './env/.env.prod', port: 2023 });
  assert.deepEqual(recipe('NODE_ENV=production env-cmd -f .env.prd next dev --turbopack'), { command: 'NODE_ENV=production next dev --turbopack', file: '.env.prd', port: 3000 });
});
test('persists isolated overrides privately without changing env files', async t => {
  const { engine, app, project, dataDir } = await fixture(t);
  await engine.saveEnv(app.id, 'dev', { API_URL: 'http://localhost:8080', TOKEN: '$(touch injected)' });
  const loaded = new Engine({ dataDir });
  assert.equal((await loaded.env(app.id, 'dev')).overrides.API_URL, 'http://localhost:8080');
  assert.deepEqual((await loaded.env(app.id, 'prod')).overrides, {});
  assert.equal((await fs.stat(path.join(dataDir, 'config.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o700);
  await engine.start(app.id, 'dev'); const values = await observed(project);
  assert.equal(values.url, 'http://localhost:8080'); assert.equal(values.token, '$(touch injected)'); assert.equal(values.multi, 'hello\nworld');
  assert.equal(await fs.readFile(path.join(project, '.env'), 'utf8'), 'KEEP=unchanged\n');
  await assert.rejects(fs.access(path.join(project, 'injected')));
  await engine.stop(app.id); assert.throws(() => process.kill(values.pid, 0), /ESRCH/);
});
test('serializes concurrent starts and switches mode through restart', async t => {
  const { engine, app, project } = await fixture(t);
  await Promise.all([engine.start(app.id, 'dev'), engine.start(app.id, 'dev')]);
  const first = await observed(project);
  await fs.unlink(path.join(project, 'observed.json'));
  await engine.restart(app.id, 'prod'); const second = await observed(project);
  assert.notEqual(first.pid, second.pid); assert.equal(second.url, 'https://prod.example');
  assert.throws(() => process.kill(first.pid, 0), /ESRCH/);
  await engine.stop(app.id); assert.equal((await engine.list()).groups[0].apps[0].status, 'stopped');
});
test('refuses an occupied port and retains error state', async t => {
  const server = net.createServer(); await new Promise(r => server.listen(0, r));
  t.after(() => new Promise(r => server.close(r)));
  const { engine, app } = await fixture(t, `PORT=${server.address().port} node server.cjs`);
  await assert.rejects(engine.start(app.id, 'dev'), /포트가 사용 중/);
  assert.equal((await engine.list()).groups[0].apps[0].status, 'error');
});
test('shutdown rejects new starts and terminates managed processes', async t => {
  const { engine, app, project } = await fixture(t); await engine.start(app.id, 'dev'); const child = await observed(project);
  await engine.shutdown(); assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
  await assert.rejects(engine.start(app.id, 'dev'), /종료하고/);
});
test('PORT override takes precedence over framework default', async t => {
  const { engine, app } = await fixture(t, 'node server.cjs # next dev');
  await engine.saveEnv(app.id, 'dev', { PORT: '49287' });
  await engine.start(app.id, 'dev');
  assert.equal((await engine.list()).groups[0].apps[0].port, 49287);
});
test('failed command surfaces error without touching source env', async t => {
  const { engine, app, project } = await fixture(t, 'cp ./env/.env.dev ./.env && nonexistent-launcher-test-command');
  await engine.start(app.id, 'dev');
  for (let i = 0; i < 30 && (await engine.list()).groups[0].apps[0].status === 'running'; i++) await delay(20);
  assert.equal((await engine.list()).groups[0].apps[0].status, 'error');
  assert.equal(await fs.readFile(path.join(project, '.env'), 'utf8'), 'KEEP=unchanged\n');
});
test('cleans up descendants when the original process exits unexpectedly', async t => {
  const { engine, app, project } = await fixture(t);
  await fs.writeFile(path.join(project, 'server.cjs'), `const cp = require('child_process'); const fs=require('fs'); const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('observed.json',JSON.stringify({pid:child.pid}));setTimeout(()=>process.exit(1),150);`);
  await engine.start(app.id, 'dev'); const child = await observed(project);
  for (let i = 0; i < 60; i++) { try { process.kill(child.pid, 0); await delay(50); } catch { break; } }
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
  assert.equal((await engine.list()).groups[0].apps[0].status, 'error');
});

test('logs continue to redact old environment values after switching mode', async t => {
  const { engine, app, project } = await fixture(t);
  await fs.writeFile(path.join(project, 'server.cjs'), "console.log(process.env.TOKEN || 'production'); setInterval(()=>{},1000);");
  await engine.start(app.id, 'dev');
  for (let i = 0; i < 60 && !engine.logs(app.id).includes('[숨김]'); i++) await delay(25);
  assert.match(engine.logs(app.id), /\[숨김\]/);
  await engine.restart(app.id, 'prod');
  assert.ok(!engine.logs(app.id).includes('base-token-private'));
});

test('selects dev and saves a changed dotenv script with isolated overrides', async t => {
  const { engine, app, project, dataDir } = await fixture(t);
  const pkg = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
  pkg.scripts.dev = 'dotenv -e env/.env.dev -- node server.cjs';
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify(pkg));
  assert.equal((await engine.discover(project)).scripts.dev, 'dev');
  await assert.rejects(engine.saveEnv(app.id, 'dev', {}, 'missing'), /스크립트/);
  await engine.saveEnv(app.id, 'dev', { API_URL: 'http://localhost:8899' }, 'dev');
  assert.equal((await new Engine({ dataDir }).env(app.id, 'dev')).script, 'dev');
  await engine.start(app.id, 'dev');
  assert.equal((await observed(project)).url, 'http://localhost:8899');
  assert.equal(await fs.readFile(path.join(project, '.env'), 'utf8'), 'KEEP=unchanged\n');
});
