// 프로젝트 그룹과 환경 설정을 보관하고 로컬 개발 서버의 수명을 관리합니다.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { parse } = require('dotenv');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ENV_PATH = '(?:"([^"\\n]+)"|\'([^\'\\n]+)\'|([^\\s;&|]+))';
function recipe(raw) {
  let command = raw || '', file;
  const cp = command.match(new RegExp('^\\s*cp\\s+' + ENV_PATH + '\\s+(?:\\./)?\\.env\\s*&&\\s*'));
  if (cp) { file = cp[1] || cp[2] || cp[3]; command = command.slice(cp[0].length); }
  const envcmd = command.match(new RegExp('env-cmd\\s+-f\\s+' + ENV_PATH + '\\s+'));
  if (envcmd) { file = envcmd[1] || envcmd[2] || envcmd[3]; command = command.replace(envcmd[0], ''); }
  const dotenv = command.match(new RegExp('^\\s*dotenv\\s+-e\\s+' + ENV_PATH + '\\s+--\\s+'));
  if (dotenv) { file = dotenv[1] || dotenv[2] || dotenv[3]; command = command.slice(dotenv[0].length); }
  const port = command.match(/(?:(?:^|\s)(?:--port|-p)(?:=|\s+)|(?:^|\s)PORT=)(\d+)/)?.[1];
  return { command, file, port: port ? Number(port) : /\b(next dev|react-scripts start)\b/.test(command) ? 3000 : /\bvite\b/.test(command) ? 5173 : undefined };
}
class Engine {
  constructor({ dataDir = path.join(os.homedir(), 'Library/Application Support/Dev Launcher'), openBrowser } = {}) {
    this.openBrowser = openBrowser; this.dataDir = dataDir; this.runtime = new Map(); this.queues = new Map(); this.saveQueue = Promise.resolve(); this.launchQueue = Promise.resolve();
    this.ready = this.load();
  }
  async load() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dataDir, 0o700);
    try { this.config = JSON.parse(await fs.readFile(path.join(this.dataDir, 'config.json'), 'utf8')); await fs.chmod(path.join(this.dataDir, 'config.json'), 0o600); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.config = { groups: [], overrides: {} };
      const root = path.join(os.homedir(), 'Documents/projects');
      for (const [name, folders] of [['Dearmonday', ['dearmonday-user', 'dearmonday-admin-v2', 'dearmonday-partner-v2', 'dearmonday-org-v2', 'dearmonday-campaign-v2']], ['Powderroom', ['powderroom-user-front', 'powderroom-admin', 'pawderroom-web-vendor']]]) {
        const group = { id: randomUUID(), name, apps: [] };
        for (const folder of folders) {
          try { const app = await this.discover(path.join(root, folder)); group.apps.push({ ...app, id: randomUUID(), name: folder.replace(/^(dearmonday-|powderroom-|pawderroom-web-)/, '').replace(/-v2$|-front$/, '') }); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (group.apps.length) this.config.groups.push(group);
      }
      await this.persist();
    }
    let changed = false;
    for (const app of this.config.groups.flatMap(g => g.apps)) {
      let pkg;
      try { pkg = JSON.parse(await fs.readFile(path.join(app.path, 'package.json'), 'utf8')); }
      catch { continue; }
      for (const mode of ['dev', 'prod']) {
        const command = pkg.scripts?.[app.scripts[mode]];
        if (!command) continue;
        const port = recipe(command).port;
        if (port === undefined) continue;
        app.ports ||= {};
        if (app.ports[mode] !== port || (mode === 'dev' && app.port !== port)) {
          app.ports[mode] = port; if (mode === 'dev') app.port = port; changed = true;
        }
      }
    }
    if (changed) await this.persist();
  }
  persist() {
    const content = JSON.stringify(this.config, null, 2);
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      const temporary = path.join(this.dataDir, 'config.tmp');
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, path.join(this.dataDir, 'config.json'));
    });
    return this.saveQueue;
  }
  app(id) { const app = this.config.groups.flatMap(g => g.apps).find(a => a.id === id); if (!app) throw new Error('프로젝트를 찾을 수 없습니다.'); return app; }
  mode(mode) { if (!['dev', 'prod'].includes(mode)) throw new Error('DEV 또는 PROD 환경을 선택해 주세요.'); }
  serial(id, fn) { const next = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(fn); this.queues.set(id, next); return next; }
  async list() {
    await this.ready;
    return { autoOpen: this.config.autoOpen !== false, groups: this.config.groups.map(g => ({ ...g, apps: g.apps.map(a => { const r = this.runtime.get(a.id); return { ...a, status: r?.status || 'stopped', mode: r?.mode || 'dev', port: r?.port || a.ports?.dev || a.port, error: r?.error }; }) })) };
  }
  async discover(directory) {
    const absolute = await fs.realpath(directory);
    const pkg = JSON.parse(await fs.readFile(path.join(absolute, 'package.json'), 'utf8'));
    const all = pkg.scripts || {};
    const choose = keys => keys.find(k => all[k]) || '';
    const scripts = { dev: choose(['dev', 'start:dev', 'start']), prod: choose(['start:prod', 'start:prd', 'prd', 'prod']) };
    const envFiles = {}, ports = {};
    for (const mode of ['dev', 'prod']) {
      const r = recipe(all[scripts[mode]]); ports[mode] = r.port;
      envFiles[mode] = r.file || '';
      if (!envFiles[mode]) for (const file of mode === 'dev' ? ['env/.env.dev', '.env.dev', '.env.development', '.env'] : ['env/.env.prod', '.env.prod', '.env.prd', '.env.production']) { try { await fs.access(path.join(absolute, file)); envFiles[mode] = file; break; } catch {} }
    }
    return { name: path.basename(absolute), path: absolute, scripts, envFiles, ports, port: ports.dev, availableScripts: Object.keys(all) };
  }
  async setAutoOpen(enabled) {
    await this.ready;
    if (typeof enabled !== 'boolean') throw new Error('자동 열기 설정이 올바르지 않습니다.');
    this.config.autoOpen = enabled; await this.persist();
  }
  async openWhenReady(id, runtime) {
    if (!this.openBrowser || !runtime.port) return;
    const current = () => !this.closing && this.config.autoOpen !== false && this.runtime.get(id) === runtime && runtime.child && !runtime.stopping;
    const deadline = Date.now() + 120000;
    while (current() && Date.now() < deadline) {
      const listening = await new Promise(resolve => {
        const socket = net.createConnection({ host: 'localhost', port: runtime.port });
        const finish = value => { socket.destroy(); resolve(value); };
        socket.setTimeout(500);
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.once('timeout', () => finish(false));
      });
      if (!current()) return;
      if (listening) { await this.openBrowser(`http://localhost:${runtime.port}`); return; }
      await delay(250);
    }
    if (current()) runtime.log = (runtime.log + '\n브라우저 자동 열기 대기 시간이 지났습니다. 서버 준비 후 열기 버튼을 눌러 주세요.\n').slice(-100000);
  }
  async addGroup(name) { await this.ready; if (!String(name).trim()) throw new Error('그룹 이름을 입력해 주세요.'); const group = { id: randomUUID(), name: String(name).trim(), apps: [] }; this.config.groups.push(group); await this.persist(); return group; }
  async addApp(groupId, config) {
    await this.ready; const group = this.config.groups.find(g => g.id === groupId); if (!group) throw new Error('그룹을 찾을 수 없습니다.');
    const found = await this.discover(config.path);
    if (this.config.groups.some(g => g.apps.some(a => a.path === found.path))) throw new Error('이미 등록된 프로젝트 폴더입니다.');
    const app = { ...found, name: config.name || found.name, scripts: config.scripts || found.scripts, envFiles: config.envFiles || found.envFiles, id: randomUUID() };
    group.apps.push(app); await this.persist(); return app;
  }
  async renameApp(id, name) {
    await this.ready;
    if (typeof name !== 'string' || !name.trim()) throw new Error('프로젝트 이름을 입력해 주세요.');
    return this.serial(id, async () => { this.app(id).name = name.trim(); await this.persist(); });
  }
  async renameGroup(id, name) {
    await this.ready;
    if (typeof name !== 'string' || !name.trim()) throw new Error('그룹 이름을 입력해 주세요.');
    const group = this.config.groups.find(g => g.id === id);
    if (!group) throw new Error('그룹을 찾을 수 없습니다.');
    group.name = name.trim(); await this.persist();
  }
  async removeApp(id) { await this.ready; return this.serial(id, async () => { await this.stopProcess(id); for (const g of this.config.groups) g.apps = g.apps.filter(a => a.id !== id); delete this.config.overrides[id]; await this.persist(); }); }
  async env(id, mode) {
    await this.ready; this.mode(mode); const app = this.app(id); let base = {};
    if (app.envFiles[mode]) base = parse(await fs.readFile(path.resolve(app.path, app.envFiles[mode])));
    const pkg = JSON.parse(await fs.readFile(path.join(app.path, 'package.json'), 'utf8'));
    return { script: app.scripts[mode] || '', availableScripts: Object.keys(pkg.scripts || {}), base: Object.entries(base).map(([key, value]) => ({ key, value })), overrides: { ...(this.config.overrides[id]?.[mode] || {}) } };
  }
  async saveEnv(id, mode, overrides, script) {
    await this.ready; this.app(id); this.mode(mode);
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('환경 설정 형식이 올바르지 않습니다.');
    for (const [key, value] of Object.entries(overrides)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('환경변수 이름 또는 값이 올바르지 않습니다.');
    if (script !== undefined) {
      const app = this.app(id), pkg = JSON.parse(await fs.readFile(path.join(app.path, 'package.json'), 'utf8'));
      if (typeof script !== 'string' || !Object.hasOwn(pkg.scripts || {}, script)) throw new Error('package.json에 있는 스크립트를 선택해 주세요.');
      app.scripts[mode] = script; app.ports ||= {}; app.ports[mode] = recipe(pkg.scripts[script]).port;
    }
    this.config.overrides[id] ||= {}; this.config.overrides[id][mode] = { ...overrides }; await this.persist();
  }
  async start(id, mode = 'dev') { await this.ready; this.mode(mode); return this.serial(id, () => { const next = this.launchQueue.catch(() => {}).then(() => this.startProcess(id, mode)); this.launchQueue = next; return next; }); }
  async startProcess(id, mode) {
    if (this.closing) throw new Error('앱을 종료하고 있습니다.');
    const app = this.app(id), old = this.runtime.get(id);
    if (old?.pid) { if (old.child && old.mode === mode) return; await this.stopProcess(id); }
    const r = { status: 'launching', mode, log: '', child: null }; this.runtime.set(id, r);
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(app.path, 'package.json'), 'utf8'));
      const script = app.scripts[mode]; if (!script || !pkg.scripts?.[script]) throw new Error(`${mode.toUpperCase()} 실행 명령을 설정해 주세요.`);
      let raw = pkg.scripts[script];
      const visited = new Set([script]);
      for (;;) {
        const alias = raw.match(/^\s*(?:npm run|yarn(?: run)?|pnpm(?: run)?)\s+([\w:.-]+)\s*$/)?.[1];
        if (!alias) break;
        if (visited.has(alias) || !pkg.scripts[alias]) throw new Error('실행 명령의 참조가 올바르지 않습니다.');
        visited.add(alias); raw = pkg.scripts[alias];
      }
      if (/\b(?:npm\s+(?:run|start)|yarn|pnpm)\b/.test(raw)) throw new Error('복합 패키지 명령은 지원하지 않습니다. 실제 서버 실행 스크립트를 선택해 주세요.');
      const parsed = recipe(raw);
      // 등록한 스크립트의 환경 로더만 분리하여 프로젝트의 .env 파일을 건드리지 않습니다.
      if (/(?:^|[;&|]\s*)\s*cp\s+[^\n]+\.env\b/.test(parsed.command) || /\b(?:env-cmd|dotenv)\b/.test(parsed.command)) throw new Error('자동 분리할 수 없는 환경 로더입니다. 환경 복사 없는 실행 명령을 선택해 주세요.');
      const values = await this.env(id, mode);
      const merged = { ...process.env, ...Object.fromEntries(values.base.map(v => [v.key, v.value])), ...values.overrides };
      const explicitPort = parsed.command.match(/(?:(?:^|\s)(?:--port|-p)(?:=|\s+)|(?:^|\s)PORT=)(\d+)/)?.[1];
      r.port = Number(explicitPort) || Number(merged.PORT) || parsed.port || undefined;
      if (r.port) {
        for (const [otherId, other] of this.runtime) if (otherId !== id && other.child && other.port === r.port) throw new Error(`${r.port} 포트를 다른 프로젝트가 사용 중입니다.`);
        await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', () => reject(new Error(`${r.port} 포트가 사용 중입니다. 기존 서버를 종료해 주세요.`))); server.listen(r.port, () => server.close(resolve)); });
      }
      const bins = []; for (let dir = app.path; ; dir = path.dirname(dir)) { bins.push(path.join(dir, 'node_modules/.bin')); if (dir === path.dirname(dir)) break; }
      merged.PATH = [...bins, path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(path.delimiter);
      merged.npm_lifecycle_event = script; merged.npm_lifecycle_script = raw; merged.npm_package_json = path.join(app.path, 'package.json'); merged.INIT_CWD = app.path;
      if (process.versions.electron) merged.ELECTRON_RUN_AS_NODE = '1';
      if (this.openBrowser) merged.BROWSER = 'none';
      const child = spawn('/bin/sh', ['-c', parsed.command], { cwd: app.path, env: merged, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      r.child = child; r.pid = child.pid;
      r.redactions = Object.values({ ...Object.fromEntries(values.base.map(v => [v.key, v.value])), ...values.overrides }).filter(value => value.length >= 4).sort((a, b) => b.length - a.length);
      const append = text => { if (r.discardLogs) return; r.log = (r.log + text).slice(-100000); };
      child.stdout.on('data', data => append(data.toString())); child.stderr.on('data', data => append(data.toString()));
      child.once('error', error => { r.error = error.message; r.status = 'error'; r.child = null; append(error.message + '\n'); });
      child.once('exit', (code, signal) => { if (r.child === child) { r.child = null; r.status = r.stopping ? 'stopped' : 'error'; if (!r.stopping) { r.error = `프로세스가 종료되었습니다 (${signal || code}).`; this.terminateGroup(child.pid).then(() => { if (r.pid === child.pid) r.pid = null; }).catch(error => { r.error = error.message; }); } } });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      r.status = 'running';
      void this.openWhenReady(id, r).catch(() => { if (r.discardLogs) return; r.log = (r.log + '\n브라우저 자동 열기에 실패했습니다. 열기 버튼으로 다시 시도해 주세요.\n').slice(-100000); });
      append(`\n[${new Date().toLocaleTimeString()}] ${mode.toUpperCase()} 실행\n`);
    } catch (error) { r.status = 'error'; r.error = error.message; throw error; }
  }
  async stop(id) { await this.ready; this.app(id); return this.serial(id, () => this.stopProcess(id)); }
  async terminateGroup(pid) {
    const kill = signal => { try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    kill('SIGTERM');
    for (let i = 0; i < 30; i++) { try { process.kill(-pid, 0); } catch { return; } await delay(100); }
    kill('SIGKILL');
  }
  async stopProcess(id) {
    const r = this.runtime.get(id); if (!r?.pid) { if (r) { r.status = 'stopped'; r.error = undefined; r.discardLogs = true; r.log = ''; r.redactions = []; } return; }
    r.stopping = true;
    r.discardLogs = true; r.log = ''; r.redactions = [];
    await this.terminateGroup(r.pid);
    r.child = null; r.pid = null; r.status = 'stopped'; r.error = undefined; r.stopping = false;
  }
  async restart(id, mode = 'dev') { await this.ready; this.mode(mode); return this.serial(id, async () => { await this.stopProcess(id); const next = this.launchQueue.catch(() => {}).then(() => this.startProcess(id, mode)); this.launchQueue = next; return next; }); }
  logs(id) { const r = this.runtime.get(id); let text = r?.log || ''; for (const value of r?.redactions || []) text = text.split(value).join('[숨김]'); return text; }
  async shutdown() { this.closing = true; await this.ready; await Promise.all(this.config.groups.flatMap(g => g.apps).map(a => this.stop(a.id))); }
}
module.exports = { Engine, recipe };
