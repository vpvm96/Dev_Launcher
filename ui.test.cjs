// 격리된 임시 프로젝트로 Electron 화면과 실행 엔진의 연결을 검증한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-ui-'));
  const project = path.join(root, 'service');
  const data = path.join(root, 'data');
  await fs.mkdir(path.join(project, 'env'), { recursive: true });
  await fs.mkdir(data);
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { 'start:dev': `cp env/.env.dev .env && node server.cjs`, 'start:prod': `cp env/.env.prod .env && node server.cjs` } }));
  await fs.writeFile(path.join(project, 'env/.env.dev'), `API_URL=https://dev.example\nPORT=${port}\n`);
  await fs.writeFile(path.join(project, 'env/.env.prod'), `API_URL=https://prod.example\nPORT=${port}\n`);
  await fs.writeFile(path.join(project, '.env'), 'PRESERVE=original\n');
  await fs.writeFile(path.join(project, 'server.cjs'), `// 테스트용 환경값을 기록하는 임시 서버\nrequire('node:fs').writeFileSync('observed.json', JSON.stringify({api: process.env.API_URL,pid:process.pid}));require('node:http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT));`);
  await fs.writeFile(path.join(data, 'config.json'), JSON.stringify({ autoOpen: false, groups: [{ id: 'test-group', name: 'Test Workspace', apps: [{ id: 'test-app', name: 'user', path: project, scripts: { dev: 'start:dev', prod: 'start:prod' }, envFiles: { dev: 'env/.env.dev', prod: 'env/.env.prod' }, ports: { dev: port, prod: port }, port }] }], overrides: {} }));
  const env = { ...process.env, DEV_LAUNCHER_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const instance = await electron.launch({ args: [__dirname], env });
  const appProcess = instance.process();
  t.after(async () => { if (appProcess.exitCode === null) await instance.close(); await fs.rm(root, { recursive: true, force: true }); });
  const page = await instance.firstWindow();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await expect(page.locator('#group-title')).toHaveText('Test Workspace');
  return { page, instance, project, errors };
}

test('desktop renders groups and starts/stops a selected fixture project', { timeout: 40000 }, async t => {
  const { page, project, errors } = await setup(t);
  await expect(page.locator('#apps')).toContainText('user');
  await page.locator('#start-selected').click();
  await expect.poll(async () => {
    try { return JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8')).api; } catch { return ''; }
  }).toBe('https://dev.example');
  await expect(page.locator('#running-count')).toContainText('1');
  await page.locator('#stop-all').click();
  await expect(page.locator('#running-count')).toContainText('0');
  assert.equal(await fs.readFile(path.join(project, '.env'), 'utf8'), 'PRESERVE=original\n');
  assert.deepEqual(errors, []);
});

test('environment editor saves an override and restarts only its service', { timeout: 40000 }, async t => {
  const { page, project, errors } = await setup(t);
  await page.locator('#start-selected').click();
  await expect.poll(async () => { try { return JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8')).pid; } catch { return 0; } }).toBeGreaterThan(0);
  const before = JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8'));
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.getByLabel('API_URL 개인 설정')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '로컬 주소 입력' }).click();
  await page.getByLabel('API_URL 개인 설정').fill('http://localhost:8899');
  await page.getByRole('button', { name: '저장 후 재시작', exact: true }).click();
  await expect(page.locator('#modal')).not.toBeVisible();
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8')).api).toBe('http://localhost:8899');
  const after = JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8'));
  assert.notEqual(after.pid, before.pid);
  assert.throws(() => process.kill(before.pid, 0), /ESRCH/);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  const row = page.locator('.env-row').filter({ hasText: 'API_URL' });
  await expect(row.getByRole('checkbox')).toBeChecked();
  await row.getByRole('checkbox').uncheck();
  await page.getByRole('button', { name: '저장 후 재시작', exact: true }).click();
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8')).api).toBe('https://dev.example');
  assert.equal(await fs.readFile(path.join(project, '.env'), 'utf8'), 'PRESERVE=original\n');
  await page.locator('#add-group').click();
  await page.getByLabel('그룹 이름', { exact: true }).fill('Another Project');
  await page.getByRole('button', { name: '그룹 만들기' }).click();
  await expect(page.locator('#group-title')).toHaveText('Another Project');
  await expect(page.locator('#apps')).toContainText('프로젝트를 연결해 주세요.');
  assert.deepEqual(errors, []);
});

test('renaming preserves a running service and persists project and group names', { timeout: 40000 }, async t => {
  const { page, project, errors } = await setup(t);
  await page.locator('#start-selected').click();
  await expect.poll(async () => { try { return JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8')).pid; } catch { return 0; } }).toBeGreaterThan(0);
  const before = JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8'));
  await page.getByRole('button', { name: 'user 이름 변경', exact: true }).click();
  await page.getByLabel('프로젝트 이름', { exact: true }).fill('   ');
  await page.getByRole('button', { name: '이름 저장' }).click();
  await expect(page.getByRole('alert')).toHaveText('이름을 입력해 주세요.');
  await page.getByLabel('프로젝트 이름', { exact: true }).fill('고객 화면');
  await page.getByRole('button', { name: '이름 저장' }).click();
  await expect(page.getByLabel('고객 화면 선택', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: '그룹 이름 변경', exact: true }).click();
  await page.getByLabel('그룹 이름', { exact: true }).fill('새 그룹 이름');
  await page.getByRole('button', { name: '이름 저장' }).click();
  await expect(page.locator('#group-title')).toHaveText('새 그룹 이름');
  await page.reload();
  await expect(page.locator('#group-title')).toHaveText('새 그룹 이름');
  await expect(page.getByLabel('고객 화면 선택', { exact: true })).toBeChecked();
  await expect(page.locator('#running-count')).toContainText('1');
  const config = JSON.parse(await fs.readFile(path.join(project, '../data/config.json'), 'utf8'));
  assert.equal(config.groups[0].name, '새 그룹 이름');
  assert.equal(config.groups[0].apps[0].name, '고객 화면');
  assert.equal(config.groups[0].apps[0].path, project);
  assert.equal(JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8')).pid, before.pid);
  assert.deepEqual(errors, []);
});

test('environment settings edit the saved launch script', { timeout: 40000 }, async t => {
  const { page, project } = await setup(t);
  const pkg = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
  pkg.scripts.dev = 'dotenv -e env/.env.dev -- node server.cjs';
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify(pkg));
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByLabel('DEV 실행 스크립트', { exact: true }).selectOption('dev');
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.getByLabel('DEV 실행 스크립트', { exact: true })).toHaveValue('dev');
  await page.keyboard.press('Escape');
  await page.locator('#start-selected').click();
  await expect.poll(async () => { try { return JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8')).api; } catch { return ''; } }).toBe('https://dev.example');
});

test('SSH settings persist per mode and explicitly apply local DB overrides', { timeout: 40000 }, async t => {
  const { page, instance, project, errors } = await setup(t);
  const pem = path.join(project, '테스트 키.pem');
  await fs.writeFile(pem, 'fixture-key-content', { mode: 0o600 });
  await instance.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, pem);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.locator('#tunnel-fields')).toBeHidden();
  await page.getByLabel('SSH 터널 사용', { exact: true }).check();
  await page.getByRole('button', { name: '키 파일 선택', exact: true }).click();
  await expect(page.getByLabel('PEM 키 경로', { exact: true })).toHaveValue(pem);
  await page.getByLabel('SSH 서버 주소', { exact: true }).fill('bastion.example.com');
  await page.getByLabel('SSH 사용자', { exact: true }).fill('ubuntu');
  await page.getByLabel('원격 DB 주소', { exact: true }).fill('db.internal');
  await expect(page.getByLabel('SSH 포트', { exact: true })).toHaveValue('22');
  await expect(page.getByLabel('원격 DB 포트', { exact: true })).toHaveValue('3306');
  await page.getByLabel('로컬 포트', { exact: true }).fill('13317');
  await expect(page.getByLabel('DB_HOST 개인 설정', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'DB 주소 적용', exact: true }).click();
  await expect(page.getByLabel('DB_HOST 개인 설정', { exact: true })).toHaveValue('127.0.0.1');
  await expect(page.getByLabel('DB_PORT 개인 설정', { exact: true })).toHaveValue('13317');
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  await expect(page.locator('#modal')).not.toBeVisible();
  const saved = await page.evaluate(() => window.launcher.env('test-app', 'dev'));
  assert.deepEqual(saved.tunnel, { enabled: true, keyPath: pem, host: 'bastion.example.com', user: 'ubuntu', sshPort: 22, localPort: 13317, remoteHost: 'db.internal', remotePort: 3306 });
  assert.equal(saved.overrides.DB_HOST, '127.0.0.1');
  const configText = await fs.readFile(path.join(project, '../data/config.json'), 'utf8');
  assert.ok(!configText.includes('fixture-key-content'));
  await page.reload();
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.getByLabel('SSH 터널 사용', { exact: true })).toBeChecked();
  await expect(page.getByLabel('로컬 포트', { exact: true })).toHaveValue('13317');
  await page.locator('#modal-body').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: 'artifacts/ssh-tunnel-settings.png' });
  await page.keyboard.press('Escape');
  await page.getByLabel('user 실행 환경', { exact: true }).selectOption('prod');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.getByLabel('SSH 터널 사용', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('DB_HOST 개인 설정', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  assert.equal((await page.evaluate(() => window.launcher.env('test-app', 'dev'))).tunnel.enabled, true);
  await page.getByLabel('user 실행 환경', { exact: true }).selectOption('dev');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByLabel('SSH 터널 사용', { exact: true }).uncheck();
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  assert.equal((await page.evaluate(() => window.launcher.env('test-app', 'dev'))).tunnel?.enabled || false, false);
  assert.equal(await fs.readFile(path.join(project, '.env'), 'utf8'), 'PRESERVE=original\n');
  assert.deepEqual(errors, []);
});

test('global browser preference persists across reloads', { timeout: 40000 }, async t => {
  const { page } = await setup(t);
  await page.getByLabel('실행 후 브라우저 열기', { exact: false }).check();
  await expect(page.locator('#auto-open')).toBeEnabled();
  await page.reload();
  await expect(page.locator('#auto-open')).toBeChecked();
});

test('project registration selects scripts from package.json', { timeout: 40000 }, async t => {
  const { page, instance, project } = await setup(t);
  const added = path.join(project, '../added-service'); await fs.cp(project, added, { recursive: true });
  await instance.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, added);
  await page.locator('#add-app').click();
  const dev = page.getByLabel('DEV 실행 스크립트', { exact: true });
  await expect(dev).toHaveJSProperty('tagName', 'SELECT');
  await expect(dev).toHaveValue('start:dev');
  await dev.selectOption('start:prod');
  await page.getByRole('button', { name: '프로젝트 연결', exact: true }).click();
  await expect(page.locator('#app-count')).toHaveText('2');
  const config = JSON.parse(await fs.readFile(path.join(project, '../data/config.json'), 'utf8'));
  assert.equal(config.groups[0].apps[1].scripts.dev, 'start:prod');
});

test('app restart shuts down managed servers before scheduling relaunch', { timeout: 40000 }, async t => {
  const { page, instance, project } = await setup(t);
  await page.locator('#start-selected').click();
  await expect.poll(async () => { try { return JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8')).pid; } catch { return 0; } }).toBeGreaterThan(0);
  const child = JSON.parse(await fs.readFile(path.join(project, 'observed.json'), 'utf8')).pid;
  const marker = path.join(project, 'relaunch.json');
  await instance.evaluate(async ({ app }, { marker, child }) => {
    const fs = process.getBuiltinModule('fs');
    app.relaunch = () => { let alive = true; try { process.kill(child, 0); } catch { alive = false; } fs.writeFileSync(marker, JSON.stringify({ alive })); };
  }, { marker, child });
  const closed = instance.waitForEvent('close');
  await page.getByRole('button', { name: '앱 재시작', exact: true }).click();
  await closed;
  assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), { alive: false });
});

test('update dialog shows current version and the available release', { timeout: 40000 }, async t => {
  const { page, instance } = await setup(t);
  await page.locator('#updates').click();
  await expect(page.locator('#modal-body')).toContainText(`현재 버전 ${require('./package.json').version}`);
  await instance.evaluate(() => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    require('electron-updater').autoUpdater.emit('update-available', { version: '1.2.0' });
  });
  await expect(page.getByRole('button', { name: '업데이트 다운로드', exact: true })).toBeVisible();
  await expect(page.locator('#update-summary')).toHaveText(`v${require('./package.json').version}`);
  await expect(page.locator('#update-notice')).toContainText('새 업데이트 v1.2.0');
});

test('latest update state has only Close and a centered close icon', { timeout: 40000 }, async t => {
  const { page, instance } = await setup(t);
  await page.locator('#updates').click();
  await instance.evaluate(() => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    require('electron-updater').autoUpdater.emit('update-not-available');
  });
  await expect(page.locator('#modal-body')).toContainText('최신 버전을 사용하고 있습니다.');
  await expect(page.locator('#modal-actions button')).toHaveCount(1);
  await expect(page.locator('#modal-actions button')).toHaveText('닫기');
  const box = await page.locator('#close-modal').boundingBox();
  const icon = await page.locator('#close-modal svg').boundingBox();
  assert.ok(Math.abs(box.x + box.width/2 - icon.x - icon.width/2) < 1);
  assert.ok(Math.abs(box.y + box.height/2 - icon.y - icon.height/2) < 1);
  await page.screenshot({ path: 'artifacts/update-current-1.1.1.png' });
});


test('one click checks immediately and waits for completion before offering download', { timeout: 40000 }, async t => {
  const { page, instance, errors } = await setup(t);
  await instance.evaluate(({ ipcMain }) => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    const updater = require('electron-updater').autoUpdater;
    globalThis.updateChecks = 0;
    ipcMain.removeHandler('checkUpdate');
    ipcMain.handle('checkUpdate', async () => {
      globalThis.updateChecks++;
      updater.emit('checking-for-update');
      await new Promise(resolve => { globalThis.finishUpdateCheck = resolve; });
      updater.emit('update-available', { version: '1.2.0' });
    });
  });
  const version = await page.locator('#update-summary').boundingBox();
  const control = await page.locator('#updates').boundingBox();
  assert.ok(version.y < control.y);
  await page.locator('#updates').click();
  await expect(page.locator('#modal-body')).toContainText('업데이트를 확인하고 있습니다.');
  await expect(page.locator('#modal-actions button')).toHaveCount(1);
  assert.equal(await instance.evaluate(() => globalThis.updateChecks), 1);
  await page.keyboard.press('Escape');
  await page.locator('#updates').click();
  assert.equal(await instance.evaluate(() => globalThis.updateChecks), 1);
  await instance.evaluate(() => globalThis.finishUpdateCheck());
  await expect(page.getByRole('button', { name: '업데이트 다운로드', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('#update-notice')).toBeVisible();
  const notice = await page.locator('#update-notice').boundingBox();
  assert.ok(notice.x < 40 && notice.y > (await page.evaluate(() => innerHeight)) / 2);
  await page.screenshot({ path: 'artifacts/update-notice.png' });
  await page.locator('#open-update').click();
  await expect(page.getByRole('button', { name: '업데이트 다운로드', exact: true })).toBeEnabled();
  assert.equal(await instance.evaluate(() => globalThis.updateChecks), 1);
  assert.deepEqual(errors, []);
});

test('background updates show a notice and downloaded updates open the install action', { timeout: 40000 }, async t => {
  const { page, instance } = await setup(t);
  await expect(page.locator('#update-notice')).toBeHidden();
  await instance.evaluate(() => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    require('electron-updater').autoUpdater.emit('update-available', { version: '1.2.0' });
  });
  await expect(page.locator('#update-notice')).toContainText('새 업데이트 v1.2.0');
  await expect(page.locator('#modal')).not.toBeVisible();
  await instance.evaluate(() => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    require('electron-updater').autoUpdater.emit('update-downloaded', { version: '1.2.0' });
  });
  await expect(page.locator('#update-notice')).toContainText('v1.2.0 설치 준비 완료');
  await page.locator('#open-update').click();
  await expect(page.getByRole('button', { name: '설치 후 재시작', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await instance.evaluate(() => {
    const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    require('electron-updater').autoUpdater.emit('update-not-available');
  });
  await expect(page.locator('#update-notice')).toBeHidden();
});


test('unchecked overrides survive saving, filtering and reopening while values show by default', { timeout: 40000 }, async t => {
  const { page, errors } = await setup(t);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  const input = page.getByLabel('API_URL 개인 설정', { exact: true });
  const row = page.locator('.env-row').filter({ hasText: 'API_URL' });
  await expect(page.getByLabel('값 표시', { exact: true })).toBeChecked();
  await expect(input).toHaveAttribute('type', 'text');
  await row.getByRole('checkbox').check();
  await input.fill('http://localhost:8899');
  await row.getByRole('checkbox').uncheck();
  await page.getByLabel('환경변수 검색').fill('PORT');
  await page.getByLabel('환경변수 검색').fill('');
  await expect(input).toHaveValue('http://localhost:8899');
  await expect(input).toBeDisabled();
  await page.getByLabel('값 표시', { exact: true }).uncheck();
  await expect(input).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.getByLabel('값 표시', { exact: true })).toBeChecked();
  await expect(input).toHaveAttribute('type', 'text');
  await expect(input).toHaveValue('http://localhost:8899');
  await expect(row.getByRole('checkbox')).not.toBeChecked();
  await expect(input).toBeDisabled();
  assert.deepEqual(await page.evaluate(() => window.launcher.env('test-app', 'dev').then(value => value.overrides)), {});
  await row.getByRole('checkbox').check();
  await expect(input).toHaveValue('http://localhost:8899');
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  assert.equal(await page.evaluate(() => window.launcher.env('test-app', 'dev').then(value => value.overrides.API_URL)), 'http://localhost:8899');
  assert.deepEqual(errors, []);
});


test('log dialog opens at the latest line and preserves manual scrolling on updates', { timeout: 40000 }, async t => {
  const { page, project, errors } = await setup(t);
  await fs.writeFile(path.join(project, 'server.cjs'), "// 긴 로그를 출력하는 테스트 서버입니다.\nconsole.log(Array.from({length:200},(_,i)=>'log line '+i).join('\\n'));setInterval(()=>console.log('latest line'),300);");
  await page.locator('#start-selected').click();
  await expect.poll(() => page.evaluate(() => window.launcher.logs('test-app'))).toContain('log line 199');
  await page.getByRole('button', { name: '로그', exact: true }).click();
  const body = page.locator('#modal-body');
  const bottomGap = () => body.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
  await expect.poll(bottomGap).toBeLessThan(2);
  await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await body.evaluate(node => { node.scrollTop = 0; });
  const before = await page.locator('#log-output').textContent();
  await expect.poll(() => page.locator('#log-output').textContent()).not.toBe(before);
  await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(0);
  await page.locator('#close-modal').click();
  await page.getByRole('button', { name: '로그', exact: true }).click();
  await expect.poll(bottomGap).toBeLessThan(2);
  assert.deepEqual(errors, []);
});
