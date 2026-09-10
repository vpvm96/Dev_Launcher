// 임시 프로젝트로 환경 보존과 서버 실행 및 종료 동작을 검증합니다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { Engine, recipe } = require('./engine.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, script = 'cp ./env/.env.dev ./.env && node server.cjs', options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-test-'));
  const project = path.join(root, 'project'); await fs.mkdir(path.join(project, 'env'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { 'start:dev': script, 'start:prod': 'cp ./env/.env.prod ./.env && node server.cjs' } }));
  await fs.writeFile(path.join(project, 'env/.env.dev'), 'API_URL="https://dev.example"\nTOKEN="base-token-private"\nMULTILINE="hello\nworld"\n');
  await fs.writeFile(path.join(project, 'env/.env.prod'), 'API_URL=https://prod.example\n');
  await fs.writeFile(path.join(project, '.env'), 'KEEP=unchanged\n');
  await fs.writeFile(path.join(project, 'server.cjs'), `const fs = require('fs'); fs.writeFileSync('observed.json', JSON.stringify({url:process.env.API_URL,multi:process.env.MULTILINE,token:process.env.TOKEN,pid:process.pid}));setInterval(()=>{},1000);`);
  const dataDir = path.join(root, 'data'); await fs.mkdir(dataDir); await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ groups: [], overrides: {} }));
  const engine = new Engine({ ...options, dataDir }); const group = await engine.addGroup('Test'); const app = await engine.addApp(group.id, { path: project });
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
test('retains disabled overrides across reloads while runtime uses defaults until reenabled', async t => {
  const { engine, app, project, dataDir } = await fixture(t);
  await engine.saveEnv(app.id, 'dev', { API_URL: 'http://localhost:8080' });
  await engine.saveEnv(app.id, 'dev', {}, undefined, undefined, { API_URL: 'http://localhost:9090', UNSAVED_KEY: '', TOKEN: '' });
  const loaded = new Engine({ dataDir });
  try {
    const values = await loaded.env(app.id, 'dev');
    assert.deepEqual(values.overrides, {});
    assert.deepEqual(values.drafts, { API_URL: 'http://localhost:9090', UNSAVED_KEY: '', TOKEN: '' });
    assert.deepEqual((await loaded.env(app.id, 'prod')).drafts, {});
    await loaded.start(app.id, 'dev');
    const defaults = await observed(project);
    assert.equal(defaults.url, 'https://dev.example');
    assert.equal(defaults.token, 'base-token-private');
    await loaded.stop(app.id);
    await fs.unlink(path.join(project, 'observed.json'));
    await loaded.saveEnv(app.id, 'dev', { API_URL: values.drafts.API_URL, TOKEN: values.drafts.TOKEN });
    await loaded.start(app.id, 'dev');
    const custom = await observed(project);
    assert.equal(custom.url, 'http://localhost:9090');
    assert.equal(custom.token, '');
    await loaded.removeApp(app.id);
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(stored.overrideDrafts[app.id], undefined);
    assert.equal(stored.overrides[app.id], undefined);
  } finally { await loaded.shutdown(); }
});
test('legacy active values seed drafts and remain retained when omitted from later saves', async t => {
  const { engine, app } = await fixture(t);
  engine.config.overrides[app.id] = { dev: { API_URL: 'legacy-value' } };
  assert.deepEqual((await engine.env(app.id, 'dev')).drafts, { API_URL: 'legacy-value' });
  await engine.saveEnv(app.id, 'dev', {});
  assert.deepEqual((await engine.env(app.id, 'dev')).drafts, { API_URL: 'legacy-value' });
  await engine.saveEnv(app.id, 'dev', { API_URL: 'active-value' }, undefined, undefined, { API_URL: 'stale-draft' });
  assert.equal((await engine.env(app.id, 'dev')).drafts.API_URL, 'active-value');
  await engine.saveEnv(app.id, 'prod', {}, undefined, undefined, { API_URL: 'prod-draft' });
  assert.equal((await engine.env(app.id, 'dev')).drafts.API_URL, 'active-value');
  assert.equal((await engine.env(app.id, 'prod')).drafts.API_URL, 'prod-draft');
});
test('rejects invalid drafts before changing active overrides or execution settings', async t => {
  const { engine, app, dataDir } = await fixture(t);
  await engine.saveEnv(app.id, 'dev', { API_URL: 'original' });
  const before = JSON.stringify(engine.config);
  const persisted = await fs.readFile(path.join(dataDir, 'config.json'), 'utf8');
  for (const drafts of [null, [], 'value', { 'BAD-NAME': 'value' }, { TOKEN: 1 }, { TOKEN: 'bad\0value' }]) {
    await assert.rejects(engine.saveEnv(app.id, 'dev', { API_URL: 'changed' }, 'start:prod', { enabled: false }, drafts), /환경/);
    assert.equal(JSON.stringify(engine.config), before);
    assert.equal(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'), persisted);
  }
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

test('short port flags are discovered and refresh previously stored defaults', async t => {
  assert.equal(recipe('dotenv -e env/.env.dev.plain -- next dev -p 2050').port, 2050);
  assert.equal(recipe('next dev --port=2050').port, 2050);
  const { engine, app, project, dataDir } = await fixture(t, 'node server.cjs -p 2050');
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
  stored.groups[0].apps[0].ports.dev = 3000;
  stored.groups[0].apps[0].port = 3000;
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify(stored));
  const loaded = new Engine({ dataDir });
  const refreshed = (await loaded.list()).groups[0].apps[0];
  assert.equal(refreshed.ports.dev, 2050);
  assert.equal(refreshed.port, 2050);
  await engine.saveEnv(app.id, 'dev', { PORT: '3000' });
  await engine.start(app.id, 'dev');
  await observed(project);
  assert.equal((await engine.list()).groups[0].apps[0].port, 2050);
});

test('opens browser once after listening and respects disable and stop', async t => {
  const listener = net.createServer(); await new Promise(r => listener.listen(0, r));
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const opened = [];
  const { engine, app, project, dataDir } = await fixture(t, `PORT=${port} node server.cjs`, { openBrowser: async url => { opened.push(url); } });
  await fs.writeFile(path.join(project, 'server.cjs'), "const fs=require('fs');fs.writeFileSync('observed.json',JSON.stringify({browser:process.env.BROWSER}));setTimeout(()=>require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT)),500);");
  await engine.start(app.id, 'dev');
  assert.equal(opened.length, 0);
  assert.equal((await observed(project)).browser, 'none');
  for (let i=0; i<60 && !opened.length; i++) await delay(50);
  assert.deepEqual(opened, [`http://localhost:${port}`]);
  await engine.start(app.id, 'dev'); await delay(300);
  assert.equal(opened.length, 1);
  await engine.setAutoOpen(false);
  assert.equal((await new Engine({ dataDir }).list()).autoOpen, false);
  await engine.restart(app.id, 'dev'); await delay(900);
  assert.equal(opened.length, 1);
  await engine.stop(app.id);
  await engine.setAutoOpen(true);
  await engine.start(app.id, 'dev'); await engine.stop(app.id); await delay(600);
  assert.equal(opened.length, 1);
});

test('stop clears logs including shutdown output and restart begins fresh', async t => {
  const { engine, app, project } = await fixture(t);
  await fs.writeFile(path.join(project, 'server.cjs'), "console.log('previous-session-output');process.on('SIGTERM',()=>{console.log('shutdown-output');process.exit(0)});setInterval(()=>{},1000);");
  await engine.start(app.id, 'dev');
  for(let i=0;i<60 && !engine.logs(app.id).includes('previous-session-output');i++) await delay(25);
  assert.match(engine.logs(app.id), /previous-session-output/);
  await engine.stop(app.id); await delay(100);
  assert.equal(engine.logs(app.id), '');
  await engine.start(app.id, 'dev');
  for(let i=0;i<60 && !engine.logs(app.id).includes('previous-session-output');i++) await delay(25);
  await fs.writeFile(path.join(project, 'server.cjs'), "console.log('new-session-output');setInterval(()=>{},1000);");
  await engine.restart(app.id, 'dev');
  for(let i=0;i<60 && !engine.logs(app.id).includes('new-session-output');i++) await delay(25);
  assert.match(engine.logs(app.id), /new-session-output/);
  assert.doesNotMatch(engine.logs(app.id), /previous-session-output|shutdown-output/);
});

test('stop clears retained failure logs after the process has exited', async t => {
  const { engine, app } = await fixture(t, "printf 'failure-output'; exit 1");
  await engine.start(app.id, 'dev');
  for(let i=0;i<60 && (await engine.list()).groups[0].apps[0].status !== 'error';i++) await delay(25);
  assert.match(engine.logs(app.id), /failure-output/);
  await engine.stop(app.id);
  assert.equal(engine.logs(app.id), '');
});

async function tunnelFixture(t) {
  const fixtureData = await fixture(t);
  const { engine, root, project } = fixtureData;
  const keyPath = path.join(root, 'key with spaces.pem');
  await fs.writeFile(keyPath, 'fixture-private-key', { mode: 0o600 });
  const sshPath = path.join(root, 'fake-ssh');
  await fs.writeFile(sshPath, `#!${process.execPath}
// 실제 네트워크 인증 없이 SSH 마스터의 준비와 종료를 재현합니다.
const fs = require('node:fs'), net = require('node:net');
const args = process.argv.slice(2), control = args[args.indexOf('-S') + 1];
if (args.includes('-O')) {
  const s = net.createConnection(control); s.on('connect', () => { s.destroy(); process.exit(0); }); s.on('error', () => process.exit(1));
} else {
  const key = args[args.indexOf('-i') + 1];
  if (fs.readFileSync(key, 'utf8') === 'reject') { console.error('Permission denied (publickey).'); process.exit(255); }
  const local = Number(args[args.indexOf('-L') + 1].split(':')[1]);
  const server = net.createServer(s => s.end());
  server.listen(local, '127.0.0.1', () => { if (fs.readFileSync(key, 'utf8') !== 'timeout') setTimeout(() => net.createServer(s => s.end()).listen(control), 120); });
  server.on('error', () => process.exit(255));
}
`, { mode: 0o700 });
  engine.tunnelOptions = { sshPath, timeout: 1500 };
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const localPort = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const tunnel = { enabled: true, keyPath, host: 'example.test', user: 'ubuntu', sshPort: 22, localPort, remoteHost: '172.31.6.181', remotePort: 3306 };
  await fs.writeFile(path.join(project, 'server.cjs'), "// 실행 환경과 PID를 기록합니다.\nrequire('fs').writeFileSync('observed.json', JSON.stringify({host:process.env.DB_HOST,port:process.env.DB_PORT,pid:process.pid}));setInterval(()=>{},1000);");
  return { ...fixtureData, tunnel };
}
test('SSH settings persist per mode, validate atomically, and keep key contents out of config', async t => {
  const { engine, app, tunnel, dataDir } = await tunnelFixture(t);
  await engine.saveEnv(app.id, 'dev', { DB_HOST: '127.0.0.1', DB_PORT: String(tunnel.localPort) }, 'start:dev', tunnel);
  const loaded = new Engine({ dataDir }); await loaded.ready;
  assert.deepEqual((await loaded.env(app.id, 'dev')).tunnel, tunnel);
  assert.equal((await loaded.env(app.id, 'prod')).tunnel, null);
  assert.ok(!(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8')).includes('fixture-private-key'));
  for (const patch of [{ host: '-oProxyCommand=bad' }, { remoteHost: 'host:22' }, { user: 'ubuntu;echo bad' }, { localPort: 0 }, { remotePort: 65536 }, { keyPath: 'relative.pem' }]) {
    await assert.rejects(engine.saveEnv(app.id, 'dev', {}, 'start:prod', { ...tunnel, ...patch }));
  }
  assert.equal((await engine.env(app.id, 'dev')).script, 'start:dev');
  assert.deepEqual((await engine.env(app.id, 'dev')).tunnel, tunnel);
});
test('SSH becomes ready before server launch and restart/stop clean up both processes', async t => {
  const { engine, app, tunnel, project } = await tunnelFixture(t);
  await engine.saveEnv(app.id, 'dev', { DB_HOST: '127.0.0.1', DB_PORT: String(tunnel.localPort) }, undefined, tunnel);
  const starting = engine.start(app.id);
  await delay(40); await assert.rejects(fs.access(path.join(project, 'observed.json')));
  await starting; const first = await observed(project);
  assert.equal(first.host, '127.0.0.1'); assert.equal(first.port, String(tunnel.localPort));
  const oldTunnel = engine.runtime.get(app.id).tunnel, sshPid = oldTunnel.child.pid;
  await fs.unlink(path.join(project, 'observed.json'));
  await engine.restart(app.id); const second = await observed(project);
  assert.notEqual(first.pid, second.pid);
  assert.throws(() => process.kill(sshPid, 0), /ESRCH/);
  await assert.rejects(fs.access(oldTunnel.directory));
  const secondSsh = engine.runtime.get(app.id).tunnel.child.pid;
  await engine.stop(app.id);
  assert.throws(() => process.kill(second.pid, 0), /ESRCH/);
  assert.throws(() => process.kill(secondSsh, 0), /ESRCH/);
  assert.equal(await fs.readFile(path.join(project, '.env'), 'utf8'), 'KEEP=unchanged\n');
});
test('SSH authentication failure and occupied local port prevent server startup', async t => {
  const { engine, app, tunnel, project } = await tunnelFixture(t);
  await engine.saveEnv(app.id, 'dev', {}, undefined, tunnel);
  await fs.writeFile(tunnel.keyPath, 'reject');
  await assert.rejects(engine.start(app.id), /Permission denied/);
  await assert.rejects(fs.access(path.join(project, 'observed.json')));
  const listener = net.createServer(); await new Promise(resolve => listener.listen(tunnel.localPort, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  await assert.rejects(engine.start(app.id), /포트가 사용 중/);
  await assert.rejects(fs.access(path.join(project, 'observed.json')));
});
test('SSH disconnection stops backend and retains an actionable error', async t => {
  const { engine, app, tunnel, project } = await tunnelFixture(t);
  await engine.saveEnv(app.id, 'dev', {}, undefined, tunnel);
  await engine.start(app.id); const backend = await observed(project);
  engine.runtime.get(app.id).tunnel.child.kill('SIGKILL');
  for (let i = 0; i < 100 && engine.runtime.get(app.id).status !== 'error'; i++) await delay(30);
  assert.equal(engine.runtime.get(app.id).status, 'error');
  assert.match(engine.runtime.get(app.id).error, /SSH 터널이 종료/);
  assert.throws(() => process.kill(backend.pid, 0), /ESRCH/);
});
test('server exit and app shutdown close the associated SSH tunnel', async t => {
  const { engine, app, tunnel, project } = await tunnelFixture(t);
  await engine.saveEnv(app.id, 'dev', {}, undefined, tunnel);
  await engine.start(app.id); const backend = await observed(project);
  const sshPid = engine.runtime.get(app.id).tunnel.child.pid;
  process.kill(backend.pid, 'SIGTERM');
  for (let i = 0; i < 100 && !engine.runtime.get(app.id).tunnel.failure; i++) await delay(30);
  assert.throws(() => process.kill(sshPid, 0), /ESRCH/);
  await engine.start(app.id);
  const nextSshPid = engine.runtime.get(app.id).tunnel.child.pid;
  await engine.shutdown();
  assert.throws(() => process.kill(nextSshPid, 0), /ESRCH/);
});

test('SSH timeout and invalid key permissions clean up without starting a backend', async t => {
  const { engine, app, tunnel, project } = await tunnelFixture(t);
  await engine.saveEnv(app.id, 'dev', {}, undefined, tunnel);
  await fs.chmod(tunnel.keyPath, 0o644);
  await assert.rejects(engine.start(app.id), /권한이 너무 넓습니다/);
  await fs.chmod(tunnel.keyPath, 0o600);
  await fs.writeFile(tunnel.keyPath, 'timeout');
  engine.tunnelOptions.timeout = 300;
  await assert.rejects(engine.start(app.id), /연결 시간이 초과/);
  const connection = engine.runtime.get(app.id).tunnel;
  assert.throws(() => process.kill(connection.child.pid, 0), /ESRCH/);
  await assert.rejects(fs.access(connection.directory));
  await assert.rejects(fs.access(path.join(project, 'observed.json')));
});

async function javaFixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-java-test-'));
  const project = path.join(root, 'Java project'); await fs.mkdir(project);
  for (const [name, contents] of Object.entries(files)) await fs.writeFile(path.join(project, name), contents);
  const dataDir = path.join(root, 'data');
  const engine = new Engine({ dataDir });
  t.after(async () => { await engine.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  return { engine, project, dataDir };
}

for (const [file, source, type, script] of [
  ['build.gradle', "plugins { id 'org.springframework.boot' version '3.5.0' }", 'gradle', 'bootRun'],
  ['build.gradle.kts', 'plugins { id("org.springframework.boot") version "3.5.0" }', 'gradle', 'bootRun'],
  ['build.gradle', "apply plugin: 'org.springframework.boot'", 'gradle', 'bootRun'],
  ['pom.xml', '<project><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>', 'maven', 'spring-boot:run']
]) {
  test(`Java discovery recognizes ${file} with ${source.startsWith('apply') ? 'legacy plugin' : 'Spring Boot plugin'}`, async t => {
    const { engine, project } = await javaFixture(t, { [file]: source });
    const found = await engine.discover(project);
    assert.equal(found.type, type);
    assert.deepEqual(found.availableScripts, [script]);
    assert.deepEqual(found.scripts, { dev: script, prod: script });
  });
}

test('Java discovery ignores commented plugins and unapplied Gradle plugins', async t => {
  const { engine, project } = await javaFixture(t, {});
  for (const source of [
    "plugins { id 'java' } // id 'org.springframework.boot' version '3.5.0'",
    '/* plugins { id("org.springframework.boot") version "3.5.0" } */',
    "plugins { id 'org.springframework.boot' version '3.5.0' apply false }",
    'plugins { id("org.springframework.boot") version "3.5.0" apply false }'
  ]) {
    await fs.writeFile(path.join(project, 'build.gradle'), source);
    assert.deepEqual((await engine.discover(project)).availableScripts, []);
  }
  await fs.unlink(path.join(project, 'build.gradle'));
  for (const source of [
    '<project><!-- <artifactId>spring-boot-maven-plugin</artifactId> --></project>',
    '<project><build><pluginManagement><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></pluginManagement></build></project>',
    '<project><profiles><profile><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></profile></profiles></project>'
  ]) {
    await fs.writeFile(path.join(project, 'pom.xml'), source);
    assert.deepEqual((await engine.discover(project)).availableScripts, []);
  }
});

test('plain folders can register and run a quoted shell file with isolated environments', async t => {
  const { engine, project, dataDir } = await javaFixture(t, {
    'start script.sh': '# 테스트 환경과 인자를 기록합니다.\npwd > directory.txt\nprintf "%s|%s" "$MESSAGE" "$1" > result.txt\necho shell-complete\n',
    '.env.dev': 'MESSAGE=development\n', '.env.prod': 'MESSAGE=production\n'
  });
  assert.equal((await engine.discover(project)).type, 'shell');
  const group = await engine.addGroup('Shell');
  const app = await engine.addApp(group.id, { path: project, scripts: { dev: 'sh "./start script.sh" "hello world"', prod: 'sh "./start script.sh" prod' }, manualScripts: { dev: true, prod: true } });
  await engine.saveEnv(app.id, 'dev', { MESSAGE: 'personal' });
  const loaded = new Engine({ dataDir }); t.after(() => loaded.shutdown());
  assert.equal((await loaded.env(app.id, 'dev')).manualScript, true);
  for (const [mode, result] of [['dev', 'personal|hello world'], ['prod', 'production|prod']]) {
    await loaded.start(app.id, mode);
    for (let i = 0; i < 100 && loaded.runtime.get(app.id).child; i++) await delay(20);
    assert.equal(await fs.readFile(path.join(project, 'result.txt'), 'utf8'), result);
    assert.equal((await fs.readFile(path.join(project, 'directory.txt'), 'utf8')).trim(), await fs.realpath(project));
    assert.equal(loaded.runtime.get(app.id).status, 'stopped');
    assert.match(await loaded.logs(app.id), /shell-complete/);
  }
});

test('manual settings persist, stop child processes, reject blanks and switch back to detected scripts', async t => {
  const { engine, app, project, dataDir } = await fixture(t);
  await fs.writeFile(path.join(project, 'start.sh'), '# 테스트 서버를 실행합니다.\nexec node server.cjs\n');
  for (const value of ['', '  ', 'bad\0command']) await assert.rejects(engine.saveEnv(app.id, 'dev', {}, value, undefined, undefined, true), /명령/);
  await engine.saveEnv(app.id, 'dev', {}, 'sh ./start.sh', undefined, undefined, true);
  assert.equal((await new Engine({ dataDir }).env(app.id, 'dev')).script, 'sh ./start.sh');
  assert.equal((await engine.env(app.id, 'prod')).manualScript, false);
  await engine.start(app.id); const child = await observed(project);
  await engine.stop(app.id); assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
  await engine.saveEnv(app.id, 'dev', {}, 'exit 7', undefined, undefined, true);
  await engine.start(app.id);
  for (let i = 0; i < 100 && engine.runtime.get(app.id).child; i++) await delay(20);
  assert.equal(engine.runtime.get(app.id).status, 'error');
  await engine.saveEnv(app.id, 'dev', {}, 'start:dev', undefined, undefined, false);
  assert.equal((await engine.env(app.id, 'dev')).manualScript, false);
  await engine.start(app.id); assert.equal(engine.runtime.get(app.id).status, 'running');
});

for (const [file, source, wrapper, script, args] of [
  ['build.gradle', "plugins { id 'org.springframework.boot' version '3.5.0' }", 'gradlew', 'bootRun', ['bootRun', '--no-daemon']],
  ['pom.xml', '<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>', 'mvnw', 'spring-boot:run', ['spring-boot:run']]
]) {
  test(`Java ${wrapper} supports environment edits, reload, start and stop without package.json`, async t => {
    const { engine, project, dataDir } = await javaFixture(t, {
      [file]: source,
      [wrapper]: '#!/bin/sh\nexec node server.cjs "$@"\n',
      '.env': 'API_URL=https://java.example\n',
      'server.cjs': "// Java 래퍼가 받은 인자와 환경을 기록합니다.\nrequire('fs').writeFileSync('observed.json',JSON.stringify({args:process.argv.slice(2),url:process.env.API_URL,pid:process.pid}));setInterval(()=>{},1000);"
    });
    await fs.chmod(path.join(project, wrapper), 0o644);
    const group = await engine.addGroup('Java');
    const app = await engine.addApp(group.id, { path: project });
    assert.deepEqual((await engine.env(app.id, 'dev')).availableScripts, [script]);
    await assert.rejects(engine.saveEnv(app.id, 'dev', {}, 'unknown-task'), /스크립트|명령/);
    await engine.saveEnv(app.id, 'dev', { API_URL: 'https://override.example' }, script);
    const loaded = new Engine({ dataDir });
    try {
      const saved = await loaded.env(app.id, 'dev');
      assert.equal(saved.script, script);
      assert.equal(saved.overrides.API_URL, 'https://override.example');
      await loaded.start(app.id, 'dev');
      const child = await observed(project);
      assert.deepEqual(child.args, args);
      assert.equal(child.url, 'https://override.example');
      await loaded.stop(app.id);
      assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
      assert.equal((await loaded.list()).groups[0].apps[0].status, 'stopped');
      assert.equal(await fs.readFile(path.join(project, '.env'), 'utf8'), 'API_URL=https://java.example\n');
    } finally { await loaded.shutdown(); }
  });
}
