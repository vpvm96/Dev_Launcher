// 화면에 필요한 프로젝트 관리 API만 격리된 브리지로 제공한다.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('launcher', Object.fromEntries(
  ['list', 'updateStatus', 'checkUpdate', 'downloadUpdate', 'installUpdate', 'restartApp', 'setAutoOpen', 'addGroup', 'chooseProject', 'choosePem', 'addApp', 'removeApp', 'renameApp', 'renameGroup', 'env', 'saveEnv', 'start', 'stop', 'restart', 'logs', 'openApp'].map(name => [name, (...args) => ipcRenderer.invoke(name, ...args)])
));
