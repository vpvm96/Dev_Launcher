// 가짜 업데이트 이벤트로 중복 실행 방지와 설치 전 서버 종료 순서를 검증합니다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdater } = require('./updater.cjs');
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  const updater = new EventEmitter();
  const calls = [];
  updater.checkForUpdates = async () => { calls.push('check'); updater.emit('update-available', { version: '1.1.0' }); };
  updater.downloadUpdate = async () => { calls.push('download'); updater.emit('update-downloaded', { version: '1.1.0' }); };
  updater.quitAndInstall = (...args) => { calls.push(['install', ...args]); };
  const api = createUpdater({ autoUpdater: updater, isPackaged: true, version: '1.0.0', beforeInstall: async () => { calls.push('cleanup'); }, ...options });
  return { updater, api, calls };
}
test('requires explicit download and gates development and unavailable installs', async () => {
  const { updater, api, calls } = fixture({ isPackaged: false });
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  await api.check(); assert.deepEqual(calls, []);
  await assert.rejects(api.download(), /업데이트가 없습니다/);
  await assert.rejects(api.install(), /먼저 다운로드/);
});
test('maps update events to plain isolated status and bounded progress', async () => {
  const { updater, api } = fixture();
  await api.check(); assert.equal(api.status().phase, 'available'); assert.equal(api.status().version, '1.1.0');
  const copy = api.status(); copy.phase = 'error'; assert.equal(api.status().phase, 'available');
  updater.emit('download-progress', { percent: 130 }); assert.equal(api.status().progress, 100);
  updater.emit('download-progress', { percent: NaN }); assert.equal(api.status().progress, 0);
  updater.emit('update-not-available', { version: '1.0.0' }); assert.equal(api.status().phase, 'current');
  assert.equal(api.status().currentVersion, '1.0.0');
  await assert.rejects(api.download(), /업데이트가 없습니다/);
});
test('does not allow overlapping checks or downloads', async () => {
  const { updater, api } = fixture(); const pending = deferred();
  updater.checkForUpdates = () => pending.promise;
  const check = api.check(); await assert.rejects(api.check(), /이미 진행/);
  updater.emit('update-available', { version: '1.1.0' });
  await assert.rejects(api.download(), /이미 진행/);
  pending.resolve(); await check;
  const downloadPending = deferred(); updater.downloadUpdate = () => downloadPending.promise;
  const download = api.download(); await assert.rejects(api.check(), /이미 진행/);
  downloadPending.resolve(); await download;
});
test('installation waits for cleanup and prevents a concurrent install', async () => {
  const cleanup = deferred(); const { api, calls } = fixture({ beforeInstall: () => cleanup.promise });
  await api.check(); await api.download(); const install = api.install();
  assert.deepEqual(calls, ['check', 'download']);
  await assert.rejects(api.install(), /이미 진행/);
  cleanup.resolve(); await install;
  assert.deepEqual(calls, ['check', 'download', ['install', false, true]]);
  await assert.rejects(api.install(), /이미 진행/);
});
test('cleanup failure prevents installation and permits retry', async () => {
  let fail = true;
  const { api, calls } = fixture({ beforeInstall: async () => { if (fail) throw new Error('cleanup failed'); } });
  await api.check(); await api.download(); await assert.rejects(api.install(), /cleanup failed/);
  assert.equal(api.status().phase, 'error'); assert.deepEqual(calls, ['check', 'download']);
  const recovered = await api.check();
  assert.equal(recovered.phase, 'downloaded'); assert.equal(recovered.message, 'cleanup failed');
  assert.equal(recovered.progress, 100); assert.deepEqual(calls, ['check', 'download']);
  fail = false; await api.install(); assert.deepEqual(calls.at(-1), ['install', false, true]);
});
test('download cancellation permits retry and errors are surfaced without stacks', async () => {
  const { updater, api } = fixture(); await api.check();
  updater.downloadUpdate = async () => { const error = new Error('cancelled'); error.name = 'CancellationError'; throw error; };
  await assert.rejects(api.download(), /cancelled/); assert.equal(api.status().phase, 'available');
  updater.emit('error', new Error('Network unavailable')); assert.equal(api.status().phase, 'error'); assert.equal(api.status().message, 'Network unavailable');
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '1.1.0' });
  await api.download(); assert.equal(api.status().phase, 'downloaded');
});
test('rejected checks surface errors and release action lock', async () => {
  const { updater, api } = fixture(); updater.checkForUpdates = async () => { throw new Error('offline'); };
  await assert.rejects(api.check(), /offline/); assert.equal(api.status().phase, 'error');
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  await api.check(); assert.equal(api.status().phase, 'current');
});

test('installation failure after cleanup explains how to recover project execution', async () => {
  const { updater, api, calls } = fixture();
  await api.check(); await api.download();
  updater.quitAndInstall = () => { throw new Error('installation unavailable'); };
  await assert.rejects(api.install(), /앱을 종료한 뒤 다시 열어/);
  assert.equal(calls.at(-1), 'cleanup');
  assert.equal(api.status().phase, 'error');
  assert.match((await api.check()).message, /앱을 종료한 뒤 다시 열어/);
  assert.equal(api.status().phase, 'downloaded');
});
