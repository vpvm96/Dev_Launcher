// 프로젝트 그룹과 환경 설정을 보관하고 로컬 개발 서버의 수명을 관리합니다.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { parse } = require('dotenv');
const { SshTunnel, validateTunnel } = require('./ssh-tunnel.cjs');
const { LogBuffer } = require('./log-buffer.cjs');
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
// 로그에서 가릴 값은 비밀번호·토큰처럼 보이는 키와 계정 정보가 들어간 접속 주소로 한정합니다.
const SECRET_KEY = /SECRET|TOKEN|PASS(WORD|WD)?|PWD|KEY|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION|SALT|DSN/i;
const CREDENTIAL_URL = /:\/\/[^\s/:@]+:[^\s/@]+@/;
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
// 상위 폴더로 올라가며 .git을 찾고 HEAD에서 브랜치 이름을 읽습니다. 워크트리의 .git 파일과 detached HEAD도 처리합니다.
async function gitBranch(directory) {
  for (let dir = directory; ; dir = path.dirname(dir)) {
    const marker = path.join(dir, '.git');
    let gitDir = null;
    try {
      const stat = await fs.stat(marker);
      if (stat.isDirectory()) gitDir = marker;
      else { const target = (await fs.readFile(marker, 'utf8')).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim(); if (target) gitDir = path.resolve(dir, target); }
    } catch { /* 이 폴더에는 .git이 없습니다. */ }
    if (gitDir) {
      try {
        const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
        return head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1] || (/^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, 7) : undefined);
      } catch { return undefined; }
    }
    if (dir === path.dirname(dir)) return undefined;
  }
}
async function isDirectory(directory) {
  try { return (await fs.stat(directory)).isDirectory(); } catch { return false; }
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
  constructor({ dataDir = path.join(os.homedir(), 'Library/Application Support/Dev Launcher'), openBrowser, tunnelOptions, notify, onChange, nodeRoots, secretBox } = {}) {
    this.secretBox = secretBox; this.tunnelOptions = tunnelOptions; this.openBrowser = openBrowser; this.notify = notify; this.onChange = onChange; this.nodeRoots = nodeRoots; this.dataDir = dataDir; this.runtime = new Map(); this.previous = new Map(); this.queues = new Map(); this.saveQueue = Promise.resolve(); this.launchQueue = Promise.resolve();
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
    let changed = await this.unsealSecrets();
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
  // 개인 환경값은 secretBox가 있으면 암호문으로 저장합니다. 복호화할 수 없으면 암호문을 따로 보관하고 빈 값으로 시작합니다.
  async unsealSecrets() {
    if (this.config.secrets === undefined) {
      this.config.overrides ||= {};
      return Boolean(this.secretBox) && (Object.keys(this.config.overrides).length > 0 || this.config.overrideDrafts !== undefined);
    }
    const sealed = this.config.secrets;
    delete this.config.secrets;
    try {
      if (!this.secretBox) throw new Error('암호화 기능을 사용할 수 없습니다.');
      const { overrides, overrideDrafts } = JSON.parse(this.secretBox.decrypt(sealed));
      this.config.overrides = overrides || {};
      if (overrideDrafts) this.config.overrideDrafts = overrideDrafts;
    } catch {
      await fs.writeFile(path.join(this.dataDir, 'secrets.unreadable'), sealed, { mode: 0o600 });
      this.config.overrides = {}; delete this.config.overrideDrafts;
      this.loadWarning = '개인 환경값을 복호화할 수 없어 빈 값으로 시작합니다. 키체인의 Dev Launcher 항목이 바뀌었을 수 있습니다. 기존 암호문은 secrets.unreadable 파일에 보관했습니다.';
    }
    return true;
  }
  serialize() {
    if (!this.secretBox) return this.config;
    const { overrides, overrideDrafts, ...rest } = this.config;
    return { ...rest, secrets: this.secretBox.encrypt(JSON.stringify({ overrides, overrideDrafts })) };
  }
  persist() {
    const content = JSON.stringify(this.serialize(), null, 2);
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
    const facts = new Map(await Promise.all(this.config.groups.flatMap(g => g.apps).map(async a => [a.id, await isDirectory(a.path) ? { missing: false, branch: await gitBranch(a.path) } : { missing: true }])));
    return { autoOpen: this.config.autoOpen !== false, trayMode: this.config.trayMode === true, readyNotify: this.config.readyNotify === true, groups: this.config.groups.map(g => ({ ...g, apps: g.apps.map(a => { const r = this.runtime.get(a.id); return { ...a, modes: modesOf(a), options: sanitizeOptions(a.options), status: r?.status || 'stopped', ready: r?.status === 'running' && r.ready === true, startedAt: r?.status === 'running' ? r.startedAt : undefined, mode: r?.mode || 'dev', port: r?.port || a.ports?.dev || a.port, error: r?.error, portConflict: r?.status === 'error' ? r.portConflict : undefined, ...facts.get(a.id) }; }) })) };
  }
  async setReadyNotify(enabled) {
    await this.ready;
    if (typeof enabled !== 'boolean') throw new Error('준비 완료 알림 설정이 올바르지 않습니다.');
    this.config.readyNotify = enabled; await this.persist();
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
  // 드래그로 옮길 때 사용합니다. index는 옮긴 뒤의 위치입니다.
  async placeGroup(id, index) {
    await this.ready; const group = this.group(id);
    await this.place(this.config.groups, group, index);
  }
  async placeApp(id, index) {
    await this.ready; const app = this.app(id);
    await this.place(this.config.groups.find(g => g.apps.includes(app)).apps, app, index);
  }
  async place(list, item, index) {
    if (!Number.isInteger(index) || index < 0 || index >= list.length) throw new Error('이동할 위치가 올바르지 않습니다.');
    list.splice(list.indexOf(item), 1); list.splice(index, 0, item); await this.persist();
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
      if (r.status === 'running' && r.ready) return true;
      await delay(300);
    }
    throw new Error('앞 프로젝트의 준비를 기다리는 시간이 지났습니다.');
  }
  clearLogs(id) { this.runtime.get(id)?.log.clear(); }
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
  // 포트가 열리면 준비됨으로 표시하고, 설정에 따라 브라우저를 엽니다. 포트를 모르면 실행 즉시 준비됨으로 봅니다.
  async watchReady(id, runtime) {
    const alive = () => !this.closing && this.runtime.get(id) === runtime && runtime.child && !runtime.stopping;
    const autoOpen = () => this.openBrowser && this.config.autoOpen !== false;
    if (!runtime.port) { runtime.ready = true; this.changed(); return; }
    const started = Date.now();
    let warned = false;
    while (alive()) {
      const listening = await portOpen(runtime.port);
      if (!alive()) return;
      if (listening) {
        runtime.ready = true; this.changed();
        if (this.config.readyNotify === true) {
          try { this.notify?.({ title: `${this.app(id).name} 준비됨`, body: `http://localhost:${runtime.port}에서 접속할 수 있습니다.` }); } catch { /* 알림 실패는 실행에 영향을 주지 않습니다. */ }
        }
        if (autoOpen() && Date.now() - started <= 120000) await this.openBrowser(`http://localhost:${runtime.port}`);
        return;
      }
      if (!warned && autoOpen() && Date.now() - started > 120000) { warned = true; runtime.log.push('\n브라우저 자동 열기 대기 시간이 지났습니다. 서버 준비 후 열기 버튼을 눌러 주세요.\n'); }
      await delay(250);
    }
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
  // 옮겨진 프로젝트 폴더를 다시 지정합니다. 실행 스크립트와 환경 설정은 그대로 유지합니다.
  async relocateApp(id, directory) {
    await this.ready;
    return this.serial(id, async () => {
      const app = this.app(id), absolute = await fs.realpath(directory);
      if (!await isDirectory(absolute)) throw new Error('프로젝트 폴더를 선택해 주세요.');
      const group = this.config.groups.find(g => g.apps.includes(app));
      if (group.apps.some(a => a !== app && a.path === absolute)) throw new Error('이 그룹에 이미 등록된 프로젝트 폴더입니다.');
      app.path = absolute;
      const pkg = await projectCommands(absolute);
      for (const mode of modesOf(app)) { app.ports ||= {}; app.ports[mode] = await this.portOf(app, pkg, mode); }
      app.port = app.ports.dev;
      await this.persist();
    });
  }
  async renameGroup(id, name) {
    await this.ready;
    if (typeof name !== 'string' || !name.trim()) throw new Error('그룹 이름을 입력해 주세요.');
    const group = this.config.groups.find(g => g.id === id);
    if (!group) throw new Error('그룹을 찾을 수 없습니다.');
    group.name = name.trim(); await this.persist();
  }
  async removeApp(id) { await this.ready; return this.serial(id, async () => { await this.stopProcess(id); for (const g of this.config.groups) g.apps = g.apps.filter(a => a.id !== id); delete this.config.overrides[id]; this.previous.delete(id); if (this.config.overrideDrafts) delete this.config.overrideDrafts[id]; await this.persist(); }); }
  async env(id, mode) {
    await this.ready; const app = this.app(id); this.mode(mode, app); let base = {}, envFileMissing = false;
    // 환경 파일이 없어도 설정 화면에서 경로를 고칠 수 있도록 빈 기본값으로 엽니다.
    if (app.envFiles[mode]) {
      try { base = parse(await fs.readFile(path.resolve(app.path, app.envFiles[mode]))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; envFileMissing = true; }
    }
    const pkg = await projectCommands(app.path);
    return { manualScript: app.manualScripts?.[mode] === true, envFile: app.envFiles[mode] || '', envFileMissing, modes: modesOf(app), options: sanitizeOptions(app.options), tunnel: app.tunnels?.[mode] || null, script: app.scripts[mode] || '', availableScripts: Object.keys(pkg.scripts || {}), base: Object.entries(base).map(([key, value]) => ({ key, value })), overrides: { ...(this.config.overrides[id]?.[mode] || {}) }, drafts: { ...this.config.overrideDrafts?.[id]?.[mode], ...this.config.overrides[id]?.[mode] } };
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
    const carried = crashes && old?.log ? old.log : new LogBuffer();
    if (old?.pid || old?.tunnel) { if (old.child && old.mode === mode) return; await this.stopProcess(id); }
    if (!crashes) this.archiveLog(id, old);
    const r = { status: 'launching', mode, log: carried, child: null, crashes }; this.runtime.set(id, r); this.changed();
    try {
      if (!await isDirectory(app.path)) throw new Error('프로젝트 폴더를 찾을 수 없습니다. 폴더를 다시 지정해 주세요.');
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
      if (values.envFileMissing) throw new Error(`환경 파일 ${values.envFile}을(를) 찾을 수 없습니다. 환경 설정에서 경로를 확인해 주세요.`);
      const merged = { ...process.env, ...Object.fromEntries(values.base.map(v => [v.key, v.value])), ...values.overrides };
      const explicitPort = parsed.command.match(/(?:(?:^|\s)(?:--port|-p)(?:=|\s+)|(?:^|\s)PORT=)(\d+)/)?.[1];
      r.port = manual || pkg.type === 'node' || pkg.type === 'shell' ? Number(explicitPort) || Number(merged.PORT) || Number(merged.SERVER_PORT) || parsed.port || undefined : Number(merged.SERVER_PORT) || await springPort(app.path);
      if (r.port) {
        for (const [otherId, other] of this.runtime) if (otherId !== id && other.child && other.port === r.port) throw new Error(`${r.port} 포트를 다른 프로젝트가 사용 중입니다.`);
        await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', () => { r.portConflict = r.port; reject(new Error(`${r.port} 포트가 사용 중입니다. 기존 서버를 종료해 주세요.`)); }); server.listen(r.port, () => server.close(resolve)); });
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
        r.log.push('SSH 터널 연결 중…\n');
        await r.tunnel.open();
        r.log.push(`SSH 터널 연결됨 · 127.0.0.1:${values.tunnel.localPort}\n`);
      }
      const bins = []; for (let dir = app.path; ; dir = path.dirname(dir)) { bins.push(path.join(dir, 'node_modules/.bin')); if (dir === path.dirname(dir)) break; }
      // 프로젝트가 .nvmrc 등으로 Node 버전을 지정하면 nvm·fnm에 설치된 해당 버전을 우선 사용합니다.
      const nodeRequest = await resolveNodeBin(app.path, this.nodeRoots);
      if (nodeRequest?.bin) { bins.push(nodeRequest.bin); r.log.push(`${nodeRequest.file}에 따라 Node ${path.basename(path.dirname(nodeRequest.bin).replace(/\/installation$/, ''))}을(를) 사용합니다.\n`); }
      else if (nodeRequest) r.log.push(`${nodeRequest.file}의 Node ${nodeRequest.version} 버전을 nvm·fnm에서 찾지 못해 기본 Node를 사용합니다.\n`);
      merged.PATH = [...bins, path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(path.delimiter);
      if (pkg.type === 'node') {
        merged.npm_lifecycle_event = script; merged.npm_lifecycle_script = raw; merged.npm_package_json = path.join(app.path, 'package.json'); merged.INIT_CWD = app.path;
        if (process.versions.electron) merged.ELECTRON_RUN_AS_NODE = '1';
      }
      if (this.openBrowser) merged.BROWSER = 'none';
      const child = spawn('/bin/sh', ['-c', parsed.command], { cwd: app.path, env: merged, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      r.child = child; r.pid = child.pid;
      r.redactions = Object.entries({ ...Object.fromEntries(values.base.map(v => [v.key, v.value])), ...values.overrides }).filter(([key, value]) => value.length >= 4 && (SECRET_KEY.test(key) || CREDENTIAL_URL.test(value))).map(([, value]) => value).sort((a, b) => b.length - a.length);
      const append = text => { if (!r.discardLogs) r.log.push(text); };
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
      r.startedAt = Date.now();
      this.setStatus(r, 'running');
      void this.watchReady(id, r).catch(() => { if (!r.discardLogs) r.log.push('\n브라우저 자동 열기에 실패했습니다. 열기 버튼으로 다시 시도해 주세요.\n'); });
      append(`\n[${new Date().toLocaleTimeString()}] ${mode.toUpperCase()} 실행\n`);
    } catch (error) { await r.tunnel?.close(); r.error = error.message; this.setStatus(r, 'error'); throw error; }
  }
  // 비정상 종료를 알리고, 옵션이 켜져 있으면 연속 3회까지 자동으로 다시 시작합니다.
  handleCrash(id, app, r, mode) {
    const restart = sanitizeOptions(app.options).autoRestart && r.crashes < 3;
    try { this.notify?.({ title: `${app.name} 종료됨`, body: `${r.error || '프로세스가 종료되었습니다.'}${restart ? ' 자동으로 다시 시작합니다.' : ''}` }); } catch { /* 알림 실패는 무시합니다. */ }
    if (!restart) return;
    r.log.push(`\n[${new Date().toLocaleTimeString()}] 비정상 종료로 자동 재시작합니다 (${r.crashes + 1}/3).\n`);
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
  // 포트를 점유한 프로세스를 lsof로 찾습니다. 결과가 없으면 lsof가 1로 종료합니다.
  async portOwners(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('포트 번호가 올바르지 않습니다.');
    let output;
    try { ({ stdout: output } = await run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'])); }
    catch (error) { if (error.code === 1) return []; throw new Error('포트를 사용하는 프로세스를 확인할 수 없습니다.'); }
    const owners = new Map();
    let current;
    for (const line of output.split('\n')) {
      if (line.startsWith('p')) { current = Number(line.slice(1)); owners.set(current, { pid: current, name: '', command: '' }); }
      else if (line.startsWith('c') && owners.has(current)) owners.get(current).name = line.slice(1);
    }
    if (!owners.size) return [];
    try {
      const { stdout } = await run('/bin/ps', ['-o', 'pid=,command=', '-p', [...owners.keys()].join(',')]);
      for (const line of stdout.split('\n')) { const match = line.match(/^\s*(\d+)\s+(.*)$/); if (match && owners.has(Number(match[1]))) owners.get(Number(match[1])).command = match[2]; }
    } catch { /* 전체 명령을 못 읽어도 프로세스 이름은 보여 줍니다. */ }
    return [...owners.values()].map(owner => ({ ...owner, command: owner.command || owner.name }));
  }
  // 지금 이 포트를 점유한 프로세스만 종료합니다. 3초 안에 끝나지 않으면 강제로 종료합니다.
  async stopPortOwner(port, pid) {
    if (!(await this.portOwners(port)).some(owner => owner.pid === pid)) throw new Error('이 포트를 사용하는 프로세스가 아닙니다.');
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 30; i++) { if (!(await this.portOwners(port)).some(owner => owner.pid === pid)) return; await delay(100); }
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  // 실행 중인 프로젝트의 프로세스 그룹별 CPU·메모리 합계를 돌려줍니다. 서버가 띄운 자식 프로세스도 포함합니다.
  async stats() {
    const groups = new Map([...this.runtime].filter(([, r]) => r.child && r.pid).map(([id, r]) => [r.pid, id]));
    if (!groups.size) return {};
    const { stdout } = await run('/bin/ps', ['-A', '-o', 'pgid=,%cpu=,rss=']);
    const result = {};
    for (const line of stdout.split('\n')) {
      const [pgid, cpu, rss] = line.trim().split(/\s+/).map(Number);
      const id = groups.get(pgid);
      if (!id) continue;
      const usage = result[id] ||= { cpu: 0, memory: 0, processes: 0 };
      usage.cpu += cpu; usage.memory += rss * 1024; usage.processes += 1;
    }
    return result;
  }
  // 그룹 안 프로젝트들의 로그를 시간순으로 합쳐 최근 limit줄을 돌려줍니다.
  groupLogs(groupId, limit = 3000) {
    const lines = [];
    this.group(groupId).apps.forEach(app => {
      const r = this.runtime.get(app.id);
      if (r) for (const entry of r.log.entries(this.redactor(r))) lines.push({ ...entry, id: app.id, name: app.name });
    });
    return lines.sort((a, b) => a.time - b.time).slice(-limit);
  }
  // 종료·재시작으로 로그를 비우기 전에 직전 실행 로그로 보관합니다. 비밀값은 보관 시점에 가립니다.
  archiveLog(id, r) {
    const text = r?.log.text(this.redactor(r));
    if (text) this.previous.set(id, { text, mode: r.mode, endedAt: Date.now() });
  }
  previousLogs(id) { return this.previous.get(id) || null; }
  async stopProcess(id) {
    const r = this.runtime.get(id); this.archiveLog(id, r); if (r?.tunnel) await r.tunnel.close(); if (!r?.pid) { if (r) { r.error = undefined; r.discardLogs = true; r.log.clear(); r.redactions = []; this.setStatus(r, 'stopped'); } return; }
    r.stopping = true;
    r.discardLogs = true; r.log.clear(); r.redactions = [];
    await this.terminateGroup(r.pid);
    r.child = null; r.pid = null; r.error = undefined; r.stopping = false; this.setStatus(r, 'stopped');
  }
  async restart(id, mode = 'dev') { await this.ready; this.mode(mode, this.app(id)); return this.serial(id, async () => { await this.stopProcess(id); const next = this.launchQueue.catch(() => {}).then(() => this.startProcess(id, mode)); this.launchQueue = next; return next; }); }
  redactor(r) { return text => { for (const value of r?.redactions || []) text = text.split(value).join('[숨김]'); return text; }; }
  logs(id) { const r = this.runtime.get(id); return r ? r.log.text(this.redactor(r)) : ''; }
  // 화면이 마지막으로 받은 줄 이후의 로그만 돌려줍니다.
  logTail(id, cursor) { const r = this.runtime.get(id); return r ? r.log.since(cursor, this.redactor(r)) : { cursor: null, reset: true, lines: [], partial: '' }; }
  async shutdown() { this.closing = true; await this.ready; await Promise.all(this.config.groups.flatMap(g => g.apps).map(a => this.stop(a.id))); }
}
module.exports = { Engine, recipe, springPort, resolveNodeBin };
