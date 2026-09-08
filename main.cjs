// 프로젝트 실행 엔진과 안전한 데스크톱 창을 연결한다.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { Engine } = require('./engine.cjs');
let engine, window, quitting = false, restarting = false;
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
app.setName('Dev Launcher');
if (process.env.DEV_LAUNCHER_DATA_DIR) app.setPath('userData', process.env.DEV_LAUNCHER_DATA_DIR);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    // Finder 실행에서도 사용자가 설치한 Node와 패키지 매니저를 찾는다.
    try {
      process.env.PATH = execFileSync('/bin/zsh', ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000 }).trim();
    } catch { /* 현재 프로세스의 PATH를 유지한다. */ }
    engine = new Engine({ dataDir: process.env.DEV_LAUNCHER_DATA_DIR || app.getPath('userData'), openBrowser: url => shell.openExternal(url) });
    const handle = (name, fn) => ipcMain.handle(name, async (event, ...args) => {
      if (event.sender !== window?.webContents || event.senderFrame.url !== page) throw new Error('허용되지 않은 요청입니다.');
      return fn(...args);
    });
    for (const method of ['list', 'setAutoOpen', 'addGroup', 'addApp', 'removeApp', 'renameApp', 'renameGroup', 'env', 'saveEnv', 'start', 'stop', 'restart', 'logs']) {
      handle(method, (...args) => engine[method](...args));
    }
    handle('restartApp', () => {
      if (restarting || quitting) return;
      restarting = true;
      setTimeout(() => app.quit(), 100);
    });
    handle('chooseProject', async () => {
      const result = await dialog.showOpenDialog(window, { title: '프로젝트 폴더 선택', properties: ['openDirectory'] });
      return result.canceled ? null : engine.discover(result.filePaths[0]);
    });
    handle('openApp', async (id) => {
      const state = await engine.list();
      const target = state.groups.flatMap(g => g.apps).find(a => a.id === id);
      if (!target || target.status !== 'running' || !Number.isInteger(Number(target.port)) || target.port < 1 || target.port > 65535) throw new Error('실행 중인 서버의 포트를 확인할 수 없습니다.');
      await shell.openExternal(`http://localhost:${Number(target.port)}`);
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
      { label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '보기', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: '윈도우', submenu: [{ role: 'minimize' }, { role: 'zoom' }] }
    ]));
    window = new BrowserWindow({ width: 1280, height: 860, minWidth: 880, minHeight: 620, title: 'Dev Launcher', backgroundColor: '#111416', titleBarStyle: 'hiddenInset', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    await window.loadFile('index.html');
  }).catch(error => { dialog.showErrorBox('Dev Launcher 시작 실패', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !engine) return;
    event.preventDefault();
    quitting = true;
    engine.shutdown().finally(() => { if (restarting) app.relaunch(); app.quit(); });
  });
}
