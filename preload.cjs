// 화면에 필요한 프로젝트 관리 API만 격리된 브리지로 제공한다.
const { contextBridge, ipcRenderer } = require('electron');
const methods = ['list', 'updateStatus', 'checkUpdate', 'downloadUpdate', 'installUpdate', 'restartApp', 'setAutoOpen', 'setTrayMode', 'addGroup', 'removeGroup', 'renameGroup', 'moveGroup', 'chooseProject', 'choosePem', 'addApp', 'removeApp', 'renameApp', 'moveApp', 'setAppOptions', 'addMode', 'removeMode', 'setEnvFile', 'env', 'saveEnv', 'start', 'stop', 'restart', 'waitReady', 'logs', 'clearLogs', 'copyText', 'openApp', 'openIn', 'exportConfig', 'importConfig'];
contextBridge.exposeInMainWorld('launcher', {
  ...Object.fromEntries(methods.map(name => [name, (...args) => ipcRenderer.invoke(name, ...args)])),
  onChange: callback => { ipcRenderer.on('changed', () => callback()); },
});
