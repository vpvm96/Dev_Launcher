// 업데이트 확인과 다운로드 상태를 관리하고 서버 종료 후 앱을 교체합니다.
function createUpdater({ autoUpdater, isPackaged, version, beforeInstall }) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  let state = { phase: 'idle', version, currentVersion: version, progress: 0, message: '' };
  let busy = false;
  let installationRequested = false;
  let available = false;
  let downloaded = false;
  const status = () => ({ ...state });
  const set = patch => { state = { ...state, ...patch }; };
  const failure = error => set({ phase: 'error', message: String(error?.message || '업데이트에 실패했습니다.').slice(0, 500) });
  const cancelled = () => set({ phase: available ? 'available' : 'idle', progress: 0, message: '다운로드가 취소되었습니다. 다시 시도할 수 있습니다.' });
  autoUpdater.on('checking-for-update', () => set({ phase: 'checking', message: '업데이트를 확인하고 있습니다.' }));
  autoUpdater.on('update-available', info => {
    available = true; downloaded = false;
    set({ phase: 'available', version: String(info.version), progress: 0, message: '새 버전을 다운로드할 수 있습니다.' });
  });
  autoUpdater.on('update-not-available', () => {
    available = false; downloaded = false;
    set({ phase: 'idle', version, progress: 0, message: '최신 버전을 사용하고 있습니다.' });
  });
  autoUpdater.on('download-progress', info => {
    const progress = Number(info.percent);
    set({ phase: 'downloading', progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0, message: '업데이트를 다운로드하고 있습니다.' });
  });
  autoUpdater.on('update-downloaded', info => {
    downloaded = true; available = true;
    set({ phase: 'downloaded', version: String(info.version), progress: 100, message: '다운로드가 완료되었습니다. 재시작하면 설치됩니다.' });
  });
  autoUpdater.on('update-cancelled', cancelled);
  autoUpdater.on('error', failure);
  async function action(work) {
    if (busy || installationRequested) throw new Error('업데이트 작업이 이미 진행 중입니다.');
    busy = true;
    try { await work(); return status(); }
    catch (error) {
      if (error?.name === 'CancellationError' || error?.code === 'ERR_UPDATER_CANCELLED') cancelled();
      else failure(error);
      throw error;
    } finally { busy = false; }
  }
  return {
    status,
    async check() {
      if (!isPackaged) { set({ message: '설치된 앱에서 업데이트를 확인할 수 있습니다.' }); return status(); }
      if (downloaded && !busy && !installationRequested) { set({ phase: 'downloaded', progress: 100 }); return status(); }
      return action(async () => {
        set({ phase: 'checking', progress: 0, message: '업데이트를 확인하고 있습니다.' });
        await autoUpdater.checkForUpdates();
      });
    },
    async download() {
      if (!isPackaged || !available || downloaded) throw new Error('다운로드할 업데이트가 없습니다.');
      return action(async () => {
        set({ phase: 'downloading', progress: 0, message: '업데이트를 다운로드하고 있습니다.' });
        await autoUpdater.downloadUpdate();
      });
    },
    async install() {
      if (!isPackaged || !downloaded) throw new Error('업데이트를 먼저 다운로드해 주세요.');
      return action(async () => {
        set({ message: '실행 중인 프로젝트를 종료한 뒤 업데이트를 설치합니다.' });
        if (typeof beforeInstall !== 'function') throw new Error('프로젝트 종료 처리가 설정되지 않았습니다.');
        await beforeInstall();
        try {
          autoUpdater.quitAndInstall(false, true);
          installationRequested = true;
        } catch (error) {
          throw new Error(`${error?.message || '업데이트 설치에 실패했습니다.'} 프로젝트를 다시 실행하려면 앱을 종료한 뒤 다시 열어 주세요.`);
        }
      });
    },
  };
}
module.exports = { createUpdater };
