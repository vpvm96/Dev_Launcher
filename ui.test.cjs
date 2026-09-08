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
  t.after(async () => { await instance.close(); await fs.rm(root, { recursive: true, force: true }); });
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
  await expect(page.getByLabel('API_URL 개인 설정')).toHaveAttribute('type', 'password');
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
