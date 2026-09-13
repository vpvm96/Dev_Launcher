// 프로젝트 실행 엔진과 안전한 데스크톱 창을 연결한다.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, Notification, nativeImage, clipboard, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { execFileSync, execFile } = require('node:child_process');
const { Engine } = require('./engine.cjs');
const { autoUpdater } = require('electron-updater');
const { createUpdater } = require('./updater.cjs');
let engine, window, tray = null, quitting = false, restarting = false;
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
app.setName('Dev Launcher');
if (process.env.DEV_LAUNCHER_DATA_DIR) app.setPath('userData', process.env.DEV_LAUNCHER_DATA_DIR);

const trayMode = () => engine?.config?.trayMode === true;
const showWindow = () => { if (!window) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); };
const notify = ({ title, body }) => { if (Notification.isSupported()) new Notification({ title, body }).show(); };
const openWith = (application, target) => new Promise((resolve, reject) => {
  execFile('/usr/bin/open', ['-a', application, target], error => error ? reject(new Error(`${application}을(를) 열 수 없습니다. 설치 여부를 확인해 주세요.`)) : resolve());
});

// 창 크기와 위치를 기억하고, 화면 밖에 저장된 값은 무시한다.
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');
async function loadWindowState() {
  try {
    const saved = JSON.parse(await fs.readFile(windowStateFile(), 'utf8'));
    if (![saved.width, saved.height].every(v => Number.isInteger(v) && v > 0)) return {};
    const state = { width: saved.width, height: saved.height };
    if (Number.isInteger(saved.x) && Number.isInteger(saved.y)) {
      const area = screen.getDisplayMatching({ x: saved.x, y: saved.y, width: saved.width, height: saved.height }).workArea;
      if (saved.x >= area.x - 20 && saved.y >= area.y - 20 && saved.x < area.x + area.width && saved.y < area.y + area.height) { state.x = saved.x; state.y = saved.y; }
    }
    return state;
  } catch { return {}; }
}
let saveWindowTimer;
function rememberWindowState() {
  clearTimeout(saveWindowTimer);
  saveWindowTimer = setTimeout(() => {
    if (!window || window.isDestroyed() || window.isFullScreen()) return;
    fs.writeFile(windowStateFile(), JSON.stringify(window.getBounds()), { mode: 0o600 }).catch(() => {});
  }, 400);
}

// 메뉴 바 아이콘에 실행 상태를 보여 주고, 창을 닫아도 서버를 유지한다.
let trayTimer;
function scheduleTray() { clearTimeout(trayTimer); trayTimer = setTimeout(() => { void refreshTray(); }, 150); }
async function refreshTray() {
  if (!engine) return;
  if (!trayMode()) { tray?.destroy(); tray = null; return; }
  const state = await engine.list();
  const apps = state.groups.flatMap(g => g.apps.map(a => ({ ...a, group: g.name })));
  const running = apps.filter(a => ['running', 'launching'].includes(a.status));
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets/icon.png')).resize({ width: 18, height: 18 }));
    tray.on('click', showWindow);
  }
  tray.setToolTip(`Dev Launcher · ${running.length}개 실행 중`);
  tray.setTitle(running.length ? String(running.length) : '');
  const marks = { running: '●', launching: '◐', error: '✕', stopped: '○' };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Dev Launcher 열기', click: showWindow },
    { type: 'separator' },
    ...(apps.length ? apps.map(a => ({
      label: `${marks[a.status] || '○'} ${a.name} · ${a.group}${['running', 'launching'].includes(a.status) ? ` (${String(a.mode).toUpperCase()})` : ''}`,
      submenu: [
        { label: '열기', enabled: a.status === 'running' && !!a.port, click: () => shell.openExternal(`http://localhost:${Number(a.port)}`) },
        { label: ['running', 'launching'].includes(a.status) ? '재시작' : '실행', click: () => engine[['running', 'launching'].includes(a.status) ? 'restart' : 'start'](a.id, a.mode || 'dev').catch(error => notify({ title: `${a.name} 실행 실패`, body: error.message })) },
        { label: '종료', enabled: ['running', 'launching'].includes(a.status), click: () => engine.stop(a.id).catch(() => {}) },
      ],
    })) : [{ label: '등록된 프로젝트가 없습니다.', enabled: false }]),
    { type: 'separator' },
    { label: '전체 종료', enabled: running.length > 0, click: () => Promise.all(running.map(a => engine.stop(a.id))).catch(() => {}) },
    { label: 'Dev Launcher 종료', click: () => app.quit() },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.whenReady().then(async () => {
    // Finder 실행에서도 사용자가 설치한 Node와 패키지 매니저를 찾는다.
    try {
      process.env.PATH = execFileSync('/bin/zsh', ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000 }).trim();
    } catch { /* 현재 프로세스의 PATH를 유지한다. */ }
    const notifyChange = () => { if (window && !window.isDestroyed()) window.webContents.send('changed'); };
    engine = new Engine({
      dataDir: process.env.DEV_LAUNCHER_DATA_DIR || app.getPath('userData'),
      openBrowser: url => shell.openExternal(url),
      notify,
      onChange: () => { notifyChange(); scheduleTray(); },
    });
    const updates = createUpdater({ autoUpdater, isPackaged: app.isPackaged, version: app.getVersion(), onChange: notifyChange, beforeInstall: async () => {
      await engine.shutdown(); quitting = true;
    } });
    const handle = (name, fn) => ipcMain.handle(name, async (event, ...args) => {
      if (event.sender !== window?.webContents || event.senderFrame.url !== page) throw new Error('허용되지 않은 요청입니다.');
      return fn(...args);
    });
    for (const method of ['list', 'setAutoOpen', 'setTrayMode', 'addGroup', 'removeGroup', 'renameGroup', 'moveGroup', 'addApp', 'removeApp', 'renameApp', 'moveApp', 'setAppOptions', 'addMode', 'removeMode', 'setEnvFile', 'env', 'saveEnv', 'start', 'stop', 'restart', 'waitReady', 'logs', 'clearLogs']) {
      handle(method, (...args) => engine[method](...args));
    }
    handle('updateStatus', () => updates.status());
    handle('checkUpdate', () => updates.check());
    handle('downloadUpdate', () => updates.download());
    handle('installUpdate', () => updates.install());
    handle('restartApp', () => {
      if (restarting || quitting) return;
      restarting = true;
      setTimeout(() => app.quit(), 100);
    });
    handle('copyText', text => { if (typeof text !== 'string') throw new Error('복사할 내용이 없습니다.'); clipboard.writeText(text); });
    handle('chooseProject', async () => {
      const result = await dialog.showOpenDialog(window, { title: '프로젝트 폴더 선택', properties: ['openDirectory'] });
      return result.canceled ? null : engine.discover(result.filePaths[0]);
    });
    handle('choosePem', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'SSH 개인 키 선택', properties: ['openFile'], filters: [{ name: 'PEM 키', extensions: ['pem'] }, { name: '모든 파일', extensions: ['*'] }] });
      return result.canceled ? null : result.filePaths[0];
    });
    handle('openApp', async (id) => {
      const state = await engine.list();
      const target = state.groups.flatMap(g => g.apps).find(a => a.id === id);
      if (!target || target.status !== 'running' || !Number.isInteger(Number(target.port)) || target.port < 1 || target.port > 65535) throw new Error('실행 중인 서버의 포트를 확인할 수 없습니다.');
      await shell.openExternal(`http://localhost:${Number(target.port)}`);
    });
    handle('openIn', async (id, target) => {
      const directory = engine.app(id).path;
      if (target === 'finder') { const error = await shell.openPath(directory); if (error) throw new Error(error); return; }
      if (target === 'terminal') return openWith('Terminal', directory);
      if (target === 'vscode') return openWith('Visual Studio Code', directory);
      throw new Error('열 수 있는 대상이 아닙니다.');
    });
    handle('exportConfig', async () => {
      const result = await dialog.showSaveDialog(window, { title: '설정 내보내기', defaultPath: path.join(app.getPath('documents'), 'dev-launcher-groups.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (result.canceled || !result.filePath) return null;
      await fs.writeFile(result.filePath, JSON.stringify(await engine.exportConfig(), null, 2));
      return result.filePath;
    });
    handle('importConfig', async () => {
      const result = await dialog.showOpenDialog(window, { title: '설정 가져오기', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (result.canceled) return null;
      let data;
      try { data = JSON.parse(await fs.readFile(result.filePaths[0], 'utf8')); } catch { throw new Error('설정 파일을 읽을 수 없습니다.'); }
      return engine.importConfig(data);
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
      { label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '보기', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: '윈도우', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] }
    ]));
    const bounds = await loadWindowState();
    window = new BrowserWindow({ width: 1280, height: 860, ...bounds, minWidth: 880, minHeight: 620, title: 'Dev Launcher', backgroundColor: '#111416', titleBarStyle: 'hiddenInset', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.on('resize', rememberWindowState); window.on('move', rememberWindowState);
    window.on('close', event => { if (trayMode() && !quitting && !restarting) { event.preventDefault(); window.hide(); } });
    await window.loadFile('index.html');
    await engine.ready; scheduleTray();
    if (app.isPackaged && !process.env.DEV_LAUNCHER_DATA_DIR) {
      setTimeout(() => { void updates.check().catch(() => {}); }, 10000).unref();
      setInterval(() => { void updates.check().catch(() => {}); }, 6 * 60 * 60 * 1000).unref();
    }
  }).catch(error => { dialog.showErrorBox('Dev Launcher 시작 실패', error.message); app.quit(); });
  app.on('window-all-closed', () => { if (!trayMode()) app.quit(); });
  app.on('before-quit', event => {
    if (quitting || !engine) return;
    event.preventDefault();
    quitting = true;
    engine.shutdown().finally(() => { tray?.destroy(); if (restarting) app.relaunch(); app.quit(); });
  });
}
