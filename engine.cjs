// 프로젝트 그룹과 환경 설정을 보관하고 로컬 개발 서버의 수명을 관리합니다.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { parse } = require('dotenv');
const { SshTunnel, validateTunnel } = require('./ssh-tunnel.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ENV_PATH = '(?:"([^"\\n]+)"|\'([^\'\\n]+)\'|([^\\s;&|]+))';
async function readOptional(directory, file) {
  try { return await fs.readFile(path.join(directory, file), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function projectCommands(directory) {
  const packageFile = await readOptional(directory, 'package.json');
  if (packageFile !== null) return { type: 'node', scripts: JSON.parse(packageFile).scripts || {} };
  for (const file of ['build.gradle', 'build.gradle.kts']) {
    const source = await readOptional(directory, file);
    if (source === null) continue;
    const text = source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, match => match.startsWith('/') ? match.replace(/[^\n]/g, ' ') : match);
    const plugin = /\bid\s*(?:\(\s*)?['"]org\.springframework\.boot['"]\s*\)?([^\n;}]*)(?:\n\s*(apply\s+false))?/g;
    const applied = [...text.matchAll(plugin)].some(match => !/apply\s+false/.test(match[1] + (match[2] || '')))
      || /\bapply\s*(?:plugin\s*:\s*|\(\s*plugin\s*=\s*)['"]org\.springframework\.boot['"]/.test(text);
    if (applied) {
      const wrapper = await readOptional(directory, 'gradlew');
      return { type: 'gradle', scripts: { bootRun: `${wrapper === null ? 'gradle' : 'sh ./gradlew'} bootRun --no-daemon` } };
    }
  }
  const pom = await readOptional(directory, 'pom.xml');
  if (pom !== null) {
    const text = pom.replace(/<!--[\s\S]*?-->/g, '').replace(/<pluginManagement\b[^>]*>[\s\S]*?<\/pluginManagement>/g, '').replace(/<profiles\b[^>]*>[\s\S]*?<\/profiles>/g, '');
    if ([...text.matchAll(/<plugin\b[^>]*>([\s\S]*?)<\/plugin>/g)].some(match => /<artifactId>\s*spring-boot-maven-plugin\s*<\/artifactId>/.test(match[1]))) {
      const wrapper = await readOptional(directory, 'mvnw');
      return { type: 'maven', scripts: { 'spring-boot:run': `${wrapper === null ? 'mvn' : 'sh ./mvnw'} spring-boot:run` } };
    }
  }
  return { type: 'shell', scripts: {} };
}
function validateScript(script, pkg, manual) {
  if (typeof script !== 'string' || !script.trim() || script.includes('\0')) throw new Error('실행 명령을 입력해 주세요.');
  if (!manual && !Object.hasOwn(pkg.scripts, script)) throw new Error('프로젝트에서 감지한 실행 스크립트를 선택해 주세요.');
}
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
const DEFAULT_MODES = ['dev', 'prod'];
const MODE_NAME = /^[a-z][a-z0-9-]{0,15}$/;
const modesOf = app => Array.isArray(app.modes) && app.modes.length ? app.modes : DEFAULT_MODES;
const sanitizeOptions = options => ({ waitForPrevious: options?.waitForPrevious === true, autoRestart: options?.autoRestart === true });
// Spring 설정 파일에서 server.port를 읽고, 없으면 Spring Boot 기본 포트를 사용합니다.
async function springPort(directory) {
  for (const file of ['application.properties', 'application.yml', 'application.yaml']) {
    const source = await readOptional(directory, path.join('src/main/resources', file));
    if (source === null) continue;
    const value = file.endsWith('.properties')
      ? source.match(/^\s*server\.port\s*[=:]\s*(\S+)/m)?.[1]
      : source.match(/^server:[ \t]*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1]?.match(/^[ \t]+port:\s*["']?([^\s"'#]+)/m)?.[1];
    if (!value) continue;
    const port = Number(value.match(/^\$\{[^:}]+:(\d+)\}$/)?.[1] ?? value);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  }
  return 8080;
}
function defaultNodeRoots() {
  const home = os.homedir();
  return [
    path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions/node'),
    path.join(process.env.FNM_DIR || path.join(home, '.local/share/fnm'), 'node-versions'),
    path.join(home, 'Library/Application Support/fnm/node-versions'),
  ];
}
// .nvmrc 또는 .node-version이 가리키는 Node 실행 파일 폴더를 nvm·fnm 설치 경로에서 찾습니다.
async function resolveNodeBin(directory, roots = defaultNodeRoots()) {
  let request = null;
  for (const file of ['.nvmrc', '.node-version']) {
    const source = await readOptional(directory, file);
    if (source !== null) { request = { file, version: source.trim().replace(/^v/, '') }; break; }
  }
  if (!request) return null;
  const wanted = request.version.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)?.slice(1).filter(Boolean).map(Number);
  if (!wanted) return { ...request, bin: null };
  let best = null;
  for (const root of roots) {
    let entries; try { entries = await fs.readdir(root); } catch { continue; }
    for (const entry of entries) {
      const found = entry.match(/^v?(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
      if (!found || wanted.some((part, index) => found[index] !== part)) continue;
      if (best && (found[0] - best.found[0] || found[1] - best.found[1] || found[2] - best.found[2]) <= 0) continue;
      for (const bin of [path.join(root, entry, 'bin'), path.join(root, entry, 'installation/bin')]) {
        try { await fs.access(path.join(bin, 'node')); best = { found, bin }; break; } catch {}
      }
    }
  }
  return { ...request, bin: best?.bin || null };
}
function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: 'localhost', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}
class Engine {
  constructor({ dataDir = path.join(os.homedir(), 'Library/Application Support/Dev Launcher'), openBrowser, tunnelOptions, notify, onChange, nodeRoots } = {}) {
    this.tunnelOptions = tunnelOptions; this.openBrowser = openBrowser; this.notify = notify; this.onChange = onChange; this.nodeRoots = nodeRoots; this.dataDir = dataDir; this.runtime = new Map(); this.queues = new Map(); this.saveQueue = Promise.resolve(); this.launchQueue = Promise.resolve();
    this.ready = this.load();
  }
  // 상태가 바뀌었음을 화면에 알립니다. 폴링 대신 즉시 갱신하는 용도입니다.
  changed() { try { this.onChange?.(); } catch { /* 알림 실패는 실행에 영향을 주지 않습니다. */ } }
  setStatus(r, status) { r.status = status; this.changed(); }
  async load() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dataDir, 0o700);
    try { this.config = JSON.parse(await fs.readFile(path.join(this.dataDir, 'config.json'), 'utf8')); await fs.chmod(path.join(this.dataDir, 'config.json'), 0o600); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.config = { groups: [], overrides: {} };
      await this.persist();
    }
    let changed = false;
    for (const app of this.config.groups.flatMap(g => g.apps)) {
      let pkg;
      try { pkg = await projectCommands(app.path); }
      catch { continue; }
      for (const mode of modesOf(app)) {
        const port = await this.portOf(app, pkg, mode);
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
      this.changed();
    });
    return this.saveQueue;
  }
  app(id) { const app = this.config.groups.flatMap(g => g.apps).find(a => a.id === id); if (!app) throw new Error('프로젝트를 찾을 수 없습니다.'); return app; }
  group(id) { const group = this.config.groups.find(g => g.id === id); if (!group) throw new Error('그룹을 찾을 수 없습니다.'); return group; }
  mode(mode, app) {
    const allowed = app ? modesOf(app) : DEFAULT_MODES;
    if (!allowed.includes(mode)) throw new Error(`실행 환경을 선택해 주세요. 사용 가능한 환경: ${allowed.map(m => m.toUpperCase()).join(', ')}`);
  }
  validModes(modes) {
    if (modes === undefined) return [...DEFAULT_MODES];
    if (!Array.isArray(modes) || !modes.length || modes.some(m => typeof m !== 'string' || !MODE_NAME.test(m)) || new Set(modes).size !== modes.length || !modes.includes('dev')) throw new Error('실행 환경 이름은 영문 소문자로 시작하는 16자 이하의 이름이어야 하며 dev를 포함해야 합니다.');
    return [...modes];
  }
  // 스크립트에서 포트를 찾고, Spring Boot 프로젝트는 설정 파일의 server.port를 사용합니다.
  async portOf(app, pkg, mode) {
    const script = app.scripts?.[mode];
    const raw = app.manualScripts?.[mode] ? script : pkg.scripts?.[script];
    if (!raw) return undefined;
    const port = recipe(raw).port;
    if (port !== undefined || app.manualScripts?.[mode]) return port;
    return ['gradle', 'maven'].includes(pkg.type) ? springPort(app.path) : undefined;
  }
  serial(id, fn) { const next = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(fn); this.queues.set(id, next); return next; }
  async list() {
    await this.ready;
    return { autoOpen: this.config.autoOpen !== false, trayMode: this.config.trayMode === true, groups: this.config.groups.map(g => ({ ...g, apps: g.apps.map(a => { const r = this.runtime.get(a.id); return { ...a, modes: modesOf(a), options: sanitizeOptions(a.options), status: r?.status || 'stopped', mode: r?.mode || 'dev', port: r?.port || a.ports?.dev || a.port, error: r?.error }; }) })) };
  }
  async setTrayMode(enabled) {
    await this.ready;
    if (typeof enabled !== 'boolean') throw new Error('메뉴 바 상주 설정이 올바르지 않습니다.');
    this.config.trayMode = enabled; await this.persist();
  }
  async removeGroup(id) {
    await this.ready; const group = this.group(id);
    for (const app of [...group.apps]) await this.removeApp(app.id);
    this.config.groups = this.config.groups.filter(g => g.id !== id); await this.persist();
  }
  async moveGroup(id, delta) {
    await this.ready; this.group(id);
    if (![1, -1].includes(delta)) throw new Error('이동 방향이 올바르지 않습니다.');
    const list = this.config.groups, from = list.findIndex(g => g.id === id), to = from + delta;
    if (to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]]; await this.persist();
  }
  async moveApp(id, delta) {
    await this.ready; this.app(id);
    if (![1, -1].includes(delta)) throw new Error('이동 방향이 올바르지 않습니다.');
    const list = this.config.groups.find(g => g.apps.some(a => a.id === id)).apps, from = list.findIndex(a => a.id === id), to = from + delta;
    if (to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]]; await this.persist();
  }
  async setAppOptions(id, options) {
    await this.ready; const app = this.app(id);
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('프로젝트 옵션 형식이 올바르지 않습니다.');
    app.options = sanitizeOptions({ ...sanitizeOptions(app.options), ...options }); await this.persist();
  }
  async addMode(id, name) {
    await this.ready; const app = this.app(id);
    if (typeof name !== 'string' || !MODE_NAME.test(name)) throw new Error('실행 환경 이름은 영문 소문자로 시작하는 16자 이하의 영문·숫자·하이픈이어야 합니다.');
    if (modesOf(app).includes(name)) throw new Error('이미 있는 실행 환경입니다.');
    app.modes = [...modesOf(app), name]; app.scripts[name] = ''; app.envFiles[name] = ''; await this.persist();
    return app.modes;
  }
  async removeMode(id, name) {
    await this.ready; const app = this.app(id);
    if (name === 'dev') throw new Error('DEV 환경은 삭제할 수 없습니다.');
    if (!modesOf(app).includes(name)) throw new Error('없는 실행 환경입니다.');
    const r = this.runtime.get(id);
    if (r?.child && r.mode === name) throw new Error('실행 중인 환경은 삭제할 수 없습니다. 먼저 종료해 주세요.');
    app.modes = modesOf(app).filter(m => m !== name);
    for (const bag of [app.scripts, app.envFiles, app.ports, app.manualScripts, app.tunnels, this.config.overrides[id], this.config.overrideDrafts?.[id]]) if (bag) delete bag[name];
    await this.persist();
    return app.modes;
  }
  // 앞 프로젝트가 실행되고 포트가 열릴 때까지 기다립니다. 다음 프로젝트를 순서대로 시작할 때 사용합니다.
  async waitReady(id, timeout = 120000) {
    await this.ready; this.app(id);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const r = this.runtime.get(id);
      if (!r || ['error', 'stopped'].includes(r.status)) throw new Error('앞 프로젝트가 실행되지 않아 대기를 중단했습니다.');
      if (r.status === 'running' && (!r.port || await portOpen(r.port))) return true;
      await delay(300);
    }
    throw new Error('앞 프로젝트의 준비를 기다리는 시간이 지났습니다.');
  }
  clearLogs(id) { const r = this.runtime.get(id); if (r) r.log = ''; }
  // 그룹과 프로젝트 구성만 내보냅니다. 개인 환경값과 SSH 키 경로는 포함하지 않습니다.
  async exportConfig() {
    await this.ready;
    return { app: 'dev-launcher', version: 1, groups: this.config.groups.map(g => ({ name: g.name, apps: g.apps.map(a => ({ name: a.name, path: a.path, scripts: { ...a.scripts }, manualScripts: { ...a.manualScripts }, envFiles: { ...a.envFiles }, modes: modesOf(a), options: sanitizeOptions(a.options) })) })) };
  }
  async importConfig(data) {
    await this.ready;
    if (!data || typeof data !== 'object' || data.app !== 'dev-launcher' || !Array.isArray(data.groups)) throw new Error('Dev Launcher 설정 파일이 아닙니다.');
    const result = { groups: 0, apps: 0, skipped: [] };
    for (const entry of data.groups) {
      if (!entry || typeof entry.name !== 'string' || !Array.isArray(entry.apps)) throw new Error('설정 파일의 그룹 형식이 올바르지 않습니다.');
      const group = await this.addGroup(entry.name); result.groups += 1;
      for (const app of entry.apps) {
        try {
          if (!app || typeof app.path !== 'string') throw new Error('프로젝트 경로가 없습니다.');
          await this.addApp(group.id, { path: app.path, name: app.name, scripts: app.scripts, manualScripts: app.manualScripts, envFiles: app.envFiles, modes: app.modes, options: app.options });
          result.apps += 1;
        } catch (error) { result.skipped.push(`${app?.name || app?.path || '이름 없음'}: ${error.message}`); }
      }
    }
    return result;
  }
  async discover(directory) {
    const absolute = await fs.realpath(directory);
    const pkg = await projectCommands(absolute);
    const all = pkg.scripts || {};
    const choose = keys => keys.find(k => all[k]) || '';
    const scripts = { dev: choose(['dev', 'start:dev', 'start']), prod: choose(['start:prod', 'start:prd', 'prd', 'prod']) };
    if (pkg.type !== 'node') scripts.dev = scripts.prod = Object.keys(all)[0] || '';
    const envFiles = {}, ports = {};
    for (const mode of ['dev', 'prod']) {
      const r = recipe(all[scripts[mode]]); ports[mode] = r.port;
      if (ports[mode] === undefined && scripts[mode] && ['gradle', 'maven'].includes(pkg.type)) ports[mode] = await springPort(absolute);
      envFiles[mode] = r.file || '';
      if (!envFiles[mode]) for (const file of mode === 'dev' ? ['env/.env.dev', '.env.dev', '.env.development', '.env'] : ['env/.env.prod', '.env.prod', '.env.prd', '.env.production']) { try { await fs.access(path.join(absolute, file)); envFiles[mode] = file; break; } catch {} }
    }
    return { name: path.basename(absolute), path: absolute, type: pkg.type, scripts, envFiles, ports, port: ports.dev, availableScripts: Object.keys(all) };
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
      const listening = await portOpen(runtime.port);
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
    if (group.apps.some(a => a.path === found.path)) throw new Error('이 그룹에 이미 등록된 프로젝트 폴더입니다.');
    const modes = this.validModes(config.modes);
    const app = { ...found, name: config.name || found.name, scripts: {}, envFiles: {}, manualScripts: {}, ports: {}, modes, options: sanitizeOptions(config.options), id: randomUUID() };
    if (typeof app.name !== 'string' || !app.name.trim()) throw new Error('프로젝트 이름을 입력해 주세요.');
    const pkg = await projectCommands(app.path);
    for (const mode of modes) {
      app.scripts[mode] = String(config.scripts?.[mode] ?? found.scripts[mode] ?? '').trim();
      app.envFiles[mode] = String(config.envFiles?.[mode] ?? found.envFiles[mode] ?? '').trim();
      if (app.envFiles[mode].includes('\0')) throw new Error('환경 파일 경로가 올바르지 않습니다.');
      app.manualScripts[mode] = config.manualScripts?.[mode] === true;
      if (app.scripts[mode] || mode === 'dev') validateScript(app.scripts[mode], pkg, app.manualScripts[mode]);
      app.ports[mode] = await this.portOf(app, pkg, mode);
    }
    app.port = app.ports.dev;
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
  async removeApp(id) { await this.ready; return this.serial(id, async () => { await this.stopProcess(id); for (const g of this.config.groups) g.apps = g.apps.filter(a => a.id !== id); delete this.config.overrides[id]; if (this.config.overrideDrafts) delete this.config.overrideDrafts[id]; await this.persist(); }); }
  async env(id, mode) {
    await this.ready; const app = this.app(id); this.mode(mode, app); let base = {};
    if (app.envFiles[mode]) base = parse(await fs.readFile(path.resolve(app.path, app.envFiles[mode])));
    const pkg = await projectCommands(app.path);
    return { manualScript: app.manualScripts?.[mode] === true, envFile: app.envFiles[mode] || '', modes: modesOf(app), options: sanitizeOptions(app.options), tunnel: app.tunnels?.[mode] || null, script: app.scripts[mode] || '', availableScripts: Object.keys(pkg.scripts || {}), base: Object.entries(base).map(([key, value]) => ({ key, value })), overrides: { ...(this.config.overrides[id]?.[mode] || {}) }, drafts: { ...this.config.overrideDrafts?.[id]?.[mode], ...this.config.overrides[id]?.[mode] } };
  }
  async setEnvFile(id, mode, file) {
    await this.ready; const app = this.app(id); this.mode(mode, app);
    if (typeof file !== 'string' || file.includes('\0')) throw new Error('환경 파일 경로가 올바르지 않습니다.');
    app.envFiles[mode] = file.trim(); await this.persist();
  }
  async saveEnv(id, mode, overrides, script, tunnel, drafts, manualScript) {
    await this.ready; this.mode(mode, this.app(id));
    for (const values of drafts === undefined ? [overrides] : [overrides, drafts]) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('환경 설정 형식이 올바르지 않습니다.');
      for (const [key, value] of Object.entries(values)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('환경변수 이름 또는 값이 올바르지 않습니다.');
    }
    const tunnelConfig = tunnel === undefined ? undefined : validateTunnel(tunnel);
    if (script !== undefined) {
      const app = this.app(id), pkg = await projectCommands(app.path);
      const manual = manualScript === undefined ? app.manualScripts?.[mode] === true : manualScript === true;
      validateScript(script, pkg, manual);
      app.scripts[mode] = script.trim(); app.manualScripts ||= {}; app.manualScripts[mode] = manual;
      app.ports ||= {}; app.ports[mode] = await this.portOf(app, pkg, mode);
      if (mode === 'dev') app.port = app.ports.dev;
    }
    if (tunnelConfig !== undefined) { this.app(id).tunnels ||= {}; this.app(id).tunnels[mode] = tunnelConfig; }
    this.config.overrideDrafts ||= {}; this.config.overrideDrafts[id] ||= {};
    this.config.overrideDrafts[id][mode] = { ...this.config.overrideDrafts[id][mode], ...this.config.overrides[id]?.[mode], ...drafts, ...overrides };
    this.config.overrides[id] ||= {}; this.config.overrides[id][mode] = { ...overrides }; await this.persist();
  }
  async start(id, mode = 'dev') { await this.ready; this.mode(mode, this.app(id)); return this.serial(id, () => { const next = this.launchQueue.catch(() => {}).then(() => this.startProcess(id, mode)); this.launchQueue = next; return next; }); }
  async startProcess(id, mode, crashes = 0) {
    if (this.closing) throw new Error('앱을 종료하고 있습니다.');
    const app = this.app(id), old = this.runtime.get(id);
    const carried = crashes ? old?.log || '' : '';
    if (old?.pid || old?.tunnel) { if (old.child && old.mode === mode) return; await this.stopProcess(id); }
    const r = { status: 'launching', mode, log: carried, child: null, crashes }; this.runtime.set(id, r); this.changed();
    try {
      const pkg = await projectCommands(app.path);
      const manual = app.manualScripts?.[mode] === true;
      const script = app.scripts[mode]; if (!script || (!manual && !Object.hasOwn(pkg.scripts, script))) throw new Error(`${mode.toUpperCase()} 실행 명령을 설정해 주세요.`);
      let raw = manual ? script : pkg.scripts[script];
      const visited = new Set([script]);
      for (; !manual;) {
        const alias = raw.match(/^\s*(?:npm run|yarn(?: run)?|pnpm(?: run)?)\s+([\w:.-]+)\s*$/)?.[1];
        if (!alias) break;
        if (visited.has(alias) || !pkg.scripts[alias]) throw new Error('실행 명령의 참조가 올바르지 않습니다.');
        visited.add(alias); raw = pkg.scripts[alias];
      }
      if (!manual && /\b(?:npm\s+(?:run|start)|yarn|pnpm)\b/.test(raw)) throw new Error('복합 패키지 명령은 지원하지 않습니다. 실제 서버 실행 스크립트를 선택해 주세요.');
      const parsed = manual ? { command: raw, port: recipe(raw).port } : recipe(raw);
      // 등록한 스크립트의 환경 로더만 분리하여 프로젝트의 .env 파일을 건드리지 않습니다.
      if (!manual && (/(?:^|[;&|]\s*)\s*cp\s+[^\n]+\.env\b/.test(parsed.command) || /\b(?:env-cmd|dotenv)\b/.test(parsed.command))) throw new Error('자동 분리할 수 없는 환경 로더입니다. 환경 복사 없는 실행 명령을 선택해 주세요.');
      const values = await this.env(id, mode);
      const merged = { ...process.env, ...Object.fromEntries(values.base.map(v => [v.key, v.value])), ...values.overrides };
      const explicitPort = parsed.command.match(/(?:(?:^|\s)(?:--port|-p)(?:=|\s+)|(?:^|\s)PORT=)(\d+)/)?.[1];
      r.port = manual || pkg.type === 'node' || pkg.type === 'shell' ? Number(explicitPort) || Number(merged.PORT) || Number(merged.SERVER_PORT) || parsed.port || undefined : Number(merged.SERVER_PORT) || await springPort(app.path);
      if (r.port) {
        for (const [otherId, other] of this.runtime) if (otherId !== id && other.child && other.port === r.port) throw new Error(`${r.port} 포트를 다른 프로젝트가 사용 중입니다.`);
        await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', () => reject(new Error(`${r.port} 포트가 사용 중입니다. 기존 서버를 종료해 주세요.`))); server.listen(r.port, () => server.close(resolve)); });
      }
      if (values.tunnel?.enabled) {
        r.tunnel = new SshTunnel(values.tunnel, { ...this.tunnelOptions, onFailure: error => {
          r.error = error.message;
          void this.serial(id, async () => {
            if (this.runtime.get(id) !== r || r.stopping) return;
            r.stopping = true;
            if (r.pid) await this.terminateGroup(r.pid);
            await r.tunnel.close();
            r.child = null; r.pid = null; r.status = 'error'; r.error = error.message; r.stopping = false;
          }).catch(error => { r.error = error.message; });
        } });
        r.log += 'SSH 터널 연결 중…\n';
        await r.tunnel.open();
        r.log += `SSH 터널 연결됨 · 127.0.0.1:${values.tunnel.localPort}\n`;
      }
      const bins = []; for (let dir = app.path; ; dir = path.dirname(dir)) { bins.push(path.join(dir, 'node_modules/.bin')); if (dir === path.dirname(dir)) break; }
      // 프로젝트가 .nvmrc 등으로 Node 버전을 지정하면 nvm·fnm에 설치된 해당 버전을 우선 사용합니다.
      const nodeRequest = await resolveNodeBin(app.path, this.nodeRoots);
      if (nodeRequest?.bin) { bins.push(nodeRequest.bin); r.log += `${nodeRequest.file}에 따라 Node ${path.basename(path.dirname(nodeRequest.bin).replace(/\/installation$/, ''))}을(를) 사용합니다.\n`; }
      else if (nodeRequest) r.log += `${nodeRequest.file}의 Node ${nodeRequest.version} 버전을 nvm·fnm에서 찾지 못해 기본 Node를 사용합니다.\n`;
      merged.PATH = [...bins, path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(path.delimiter);
      if (pkg.type === 'node') {
        merged.npm_lifecycle_event = script; merged.npm_lifecycle_script = raw; merged.npm_package_json = path.join(app.path, 'package.json'); merged.INIT_CWD = app.path;
        if (process.versions.electron) merged.ELECTRON_RUN_AS_NODE = '1';
      }
      if (this.openBrowser) merged.BROWSER = 'none';
      const child = spawn('/bin/sh', ['-c', parsed.command], { cwd: app.path, env: merged, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      r.child = child; r.pid = child.pid;
      r.redactions = Object.values({ ...Object.fromEntries(values.base.map(v => [v.key, v.value])), ...values.overrides }).filter(value => value.length >= 4).sort((a, b) => b.length - a.length);
      const append = text => { if (r.discardLogs) return; r.log = (r.log + text).slice(-100000); };
      child.stdout.on('data', data => append(data.toString())); child.stderr.on('data', data => append(data.toString()));
      child.once('error', error => { r.error = error.message; r.child = null; this.setStatus(r, 'error'); append(error.message + '\n'); });
      child.once('exit', (code, signal) => {
        if (r.child !== child) return;
        r.child = null;
        const crashed = !r.stopping && !(manual && code === 0);
        if (!r.stopping) {
          if (crashed) r.error = `프로세스가 종료되었습니다 (${signal || code}).`;
          Promise.all([this.terminateGroup(child.pid), r.tunnel?.close()]).then(() => { if (r.pid === child.pid) r.pid = null; }).catch(error => { r.error = error.message; });
        }
        this.setStatus(r, crashed ? 'error' : 'stopped');
        if (crashed && !this.closing) this.handleCrash(id, app, r, mode);
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      this.setStatus(r, 'running');
      void this.openWhenReady(id, r).catch(() => { if (r.discardLogs) return; r.log = (r.log + '\n브라우저 자동 열기에 실패했습니다. 열기 버튼으로 다시 시도해 주세요.\n').slice(-100000); });
      append(`\n[${new Date().toLocaleTimeString()}] ${mode.toUpperCase()} 실행\n`);
    } catch (error) { await r.tunnel?.close(); r.error = error.message; this.setStatus(r, 'error'); throw error; }
  }
  // 비정상 종료를 알리고, 옵션이 켜져 있으면 연속 3회까지 자동으로 다시 시작합니다.
  handleCrash(id, app, r, mode) {
    const restart = sanitizeOptions(app.options).autoRestart && r.crashes < 3;
    try { this.notify?.({ title: `${app.name} 종료됨`, body: `${r.error || '프로세스가 종료되었습니다.'}${restart ? ' 자동으로 다시 시작합니다.' : ''}` }); } catch { /* 알림 실패는 무시합니다. */ }
    if (!restart) return;
    r.log = (r.log + `\n[${new Date().toLocaleTimeString()}] 비정상 종료로 자동 재시작합니다 (${r.crashes + 1}/3).\n`).slice(-100000);
    setTimeout(() => {
      void this.serial(id, async () => {
        if (this.closing || this.runtime.get(id) !== r || r.status !== 'error') return;
        if (r.pid) await this.terminateGroup(r.pid).catch(() => {});
        const next = this.launchQueue.catch(() => {}).then(() => this.startProcess(id, mode, r.crashes + 1)); this.launchQueue = next; return next;
      }).catch(() => {});
    }, 2000).unref?.();
  }
  async stop(id) { await this.ready; this.app(id); return this.serial(id, () => this.stopProcess(id)); }
  async terminateGroup(pid) {
    const kill = signal => { try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    kill('SIGTERM');
    for (let i = 0; i < 30; i++) { try { process.kill(-pid, 0); } catch { return; } await delay(100); }
    kill('SIGKILL');
  }
  async stopProcess(id) {
    const r = this.runtime.get(id); if (r?.tunnel) await r.tunnel.close(); if (!r?.pid) { if (r) { r.error = undefined; r.discardLogs = true; r.log = ''; r.redactions = []; this.setStatus(r, 'stopped'); } return; }
    r.stopping = true;
    r.discardLogs = true; r.log = ''; r.redactions = [];
    await this.terminateGroup(r.pid);
    r.child = null; r.pid = null; r.error = undefined; r.stopping = false; this.setStatus(r, 'stopped');
  }
  async restart(id, mode = 'dev') { await this.ready; this.mode(mode, this.app(id)); return this.serial(id, async () => { await this.stopProcess(id); const next = this.launchQueue.catch(() => {}).then(() => this.startProcess(id, mode)); this.launchQueue = next; return next; }); }
  logs(id) { const r = this.runtime.get(id); let text = r?.log || ''; for (const value of r?.redactions || []) text = text.split(value).join('[숨김]'); return text; }
  async shutdown() { this.closing = true; await this.ready; await Promise.all(this.config.groups.flatMap(g => g.apps).map(a => this.stop(a.id))); }
}
module.exports = { Engine, recipe, springPort, resolveNodeBin };
