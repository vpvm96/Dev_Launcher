// 프로젝트 실행 상태와 그룹별 환경 편집을 연결하는 데스크톱 화면 로직
const api = window.launcher;
const $ = (id) => document.getElementById(id);
const DEFAULT_MODES = ['dev', 'prod'];
const state = {
  groups: [], group: null, selected: new Map(), modes: new Map(), busy: new Set(), waiting: new Set(),
  signature: '', logs: null, logLines: [], logPartial: '', logCursor: null, logFilter: '', refreshing: false,
};
try {
  const saved = JSON.parse(localStorage.getItem('launcher-selection') || '{}');
  state.group = typeof saved.group === 'string' ? saved.group : null;
  state.selected = new Map((Array.isArray(saved.selected) ? saved.selected : [])
    .filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean'));
  state.modes = new Map((Array.isArray(saved.modes) ? saved.modes : [])
    .filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'));
} catch { /* 저장된 화면 설정이 손상되었으면 기본 선택을 사용한다. */ }

function persistSelection() {
  try {
    localStorage.setItem('launcher-selection', JSON.stringify({ group: state.group, selected: [...state.selected], modes: [...state.modes] }));
  } catch { /* 저장소를 사용할 수 없어도 현재 세션은 계속 동작한다. */ }
}
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text, handler, cls = '') => {
  const node = el('button', cls, text);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
};
const currentGroup = () => state.groups.find((group) => group.id === state.group);
const modesOf = (app) => (Array.isArray(app.modes) && app.modes.length ? app.modes : DEFAULT_MODES);
const mode = (app) => {
  const chosen = state.modes.get(app.id);
  return modesOf(app).includes(chosen) ? chosen : (modesOf(app).includes(app.mode) ? app.mode : 'dev');
};
const active = (app) => ['running', 'launching'].includes(app.status);
const upper = (value) => String(value).toUpperCase();

function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').className = error ? 'error' : '';
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 3500);
}
async function attempt(fn) {
  try { return await fn(); }
  catch (error) { toast(error.message || String(error), true); }
}

// 상태 변경 이벤트로 즉시 갱신하고, 이벤트를 놓친 경우를 위해 느린 주기로도 확인한다.
async function refresh(force = false) {
  if (state.refreshing) { state.refreshAgain = true; return; }
  state.refreshing = true;
  try {
    const data = await api.list();
    const update = await api.updateStatus();
    renderUpdateStatus(update);
    if (!$('auto-open').disabled) $('auto-open').checked = data.autoOpen;
    state.trayMode = data.trayMode;
    state.readyNotify = data.readyNotify;
    state.groups = data.groups;
    if (!currentGroup()) state.group = state.groups[0]?.id || null;
    for (const group of state.groups) for (const app of group.apps) {
      if (!state.selected.has(app.id)) state.selected.set(app.id, true);
      if (!state.modes.has(app.id)) state.modes.set(app.id, mode(app));
    }
    const signature = JSON.stringify([data.groups, state.group, [...state.busy], [...state.waiting]]);
    if (force || signature !== state.signature) { state.signature = signature; render(); }
  } finally {
    state.refreshing = false;
    if (state.refreshAgain) { state.refreshAgain = false; void attempt(() => refresh()); }
  }
}
// 마지막으로 받은 줄 이후만 가져와 화면에 덧붙인다. 버퍼가 비워졌으면 전체를 다시 그린다.
async function refreshLogs() {
  if (!state.logs || !$('modal').open || !$('log-output')) return;
  const id = state.logs;
  const tail = await api.logTail(id, state.logCursor);
  if (state.logs !== id) return;
  state.logCursor = tail.cursor;
  if (tail.reset) { state.logLines = tail.lines; state.logPartial = tail.partial; drawLogs(); return; }
  if (!tail.lines.length && tail.partial === state.logPartial) return;
  state.logLines.push(...tail.lines);
  state.logPartial = tail.partial;
  if (state.logLines.length > LOG_LIMIT) { state.logLines.splice(0, state.logLines.length - LOG_LIMIT); drawLogs(); }
  else drawLogs(tail.lines);
}

function counts() {
  persistSelection();
  const apps = currentGroup()?.apps || [];
  const selected = apps.filter((app) => state.selected.get(app.id));
  $('selection-count').textContent = `${selected.length}개 선택`;
  $('start-selected').disabled = !selected.length || selected.some((app) => state.busy.has(app.id) || state.waiting.has(app.id));
  $('stop-all').disabled = !apps.some(active);
}

// 핸들을 끌어 같은 목록 안에서 순서를 바꾼다. 놓은 위치가 항목의 위쪽 절반이면 앞에, 아래쪽이면 뒤에 넣는다.
function sortable(node, handle, kind, id, position, place) {
  handle.draggable = true;
  const after = (event) => { const rect = node.getBoundingClientRect(); return event.clientY > rect.top + rect.height / 2; };
  const unmark = () => node.classList.remove('drop-before', 'drop-after');
  const accepts = () => state.drag?.kind === kind && state.drag.id !== id;
  handle.addEventListener('dragstart', (event) => {
    state.drag = { kind, id, position };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
    node.classList.add('dragging');
  });
  handle.addEventListener('dragend', () => {
    state.drag = null;
    node.classList.remove('dragging');
    if (state.renderPending) { state.renderPending = false; render(); }
  });
  node.addEventListener('dragover', (event) => {
    if (!accepts()) return;
    event.preventDefault();
    node.classList.toggle('drop-before', !after(event));
    node.classList.toggle('drop-after', after(event));
  });
  node.addEventListener('dragleave', unmark);
  node.addEventListener('drop', (event) => {
    if (!accepts()) return;
    event.preventDefault();
    unmark();
    const from = state.drag.position, dragged = state.drag.id;
    let to = position + (after(event) ? 1 : 0);
    if (from < to) to -= 1;
    if (to !== from) void attempt(async () => { await place(dragged, to); await refresh(true); });
  });
}

function render() {
  // 끌고 있는 동안 목록을 다시 그리면 드래그가 끊기므로 끝난 뒤에 그린다.
  if (state.drag) { state.renderPending = true; return; }
  const focusKey = document.activeElement?.dataset.focus;
  $('groups').replaceChildren(...state.groups.map((group, position) => {
    const node = button('', () => { state.group = group.id; render(); }, `group-button${group.id === state.group ? ' active' : ''}`);
    node.append(el('span', '', group.name), el('span', '', String(group.apps.length)));
    node.setAttribute('aria-current', group.id === state.group ? 'page' : 'false');
    node.title = '끌어서 순서를 바꿀 수 있습니다.';
    sortable(node, node, 'group', group.id, position, (id, index) => api.placeGroup(id, index));
    return node;
  }));
  const group = currentGroup();
  const apps = group?.apps || [];
  const index = state.groups.findIndex((item) => item.id === state.group);
  $('group-title').textContent = group?.name || '나의 개발 워크스페이스';
  $('group-description').textContent = group ? '필요한 프로젝트를 선택하고 작업을 시작하세요.' : '첫 번째 그룹을 추가해서 시작하세요.';
  $('rename-group').disabled = !group;
  $('remove-group').disabled = !group;
  $('group-up').disabled = !group || index <= 0;
  $('group-down').disabled = !group || index >= state.groups.length - 1;
  $('add-app').disabled = !group;
  $('group-mode').disabled = !group;
  $('app-count').textContent = String(apps.length);
  $('running-count').textContent = `${apps.filter(active).length}개 실행 중`;
  renderGroupMode(apps);
  $('apps').replaceChildren(...apps.map((app, position) => renderApp(app, position, apps.length)));
  if (!apps.length) {
    const empty = el('div', 'empty');
    empty.append(
      el('h2', '', group ? '프로젝트를 연결해 주세요.' : '작업을 그룹으로 모아보세요.'),
      el('p', '', group ? '프로젝트 폴더를 선택하면 실행 명령과 환경 파일을 찾아드려요.' : '프론트엔드와 백엔드처럼 함께 켤 프로젝트를 묶어주세요.'),
      button(group ? '＋ 프로젝트 폴더 선택' : '＋ 첫 그룹 만들기', group ? addApp : addGroup, 'primary'),
    );
    $('apps').append(empty);
  }
  counts();
  if (focusKey) [...document.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === focusKey)?.focus({ preventScroll: true });
}

// 그룹 환경 선택지는 그룹 내 프로젝트가 가진 환경을 모두 모아 보여 준다.
function renderGroupMode(apps) {
  const select = $('group-mode');
  const available = [...new Set([...DEFAULT_MODES, ...apps.flatMap(modesOf)])];
  const chosen = new Set(apps.map(mode));
  select.replaceChildren(...available.map((value) => { const option = el('option', '', upper(value)); option.value = value; return option; }));
  if (chosen.size > 1) {
    const option = el('option', '', '개별 설정');
    option.value = 'mixed';
    select.append(option);
    select.value = 'mixed';
  } else select.value = [...chosen][0] || 'dev';
}

function renderApp(app, position, total) {
  const card = el('article', 'app-card');
  const top = el('div', 'card-top');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = state.selected.get(app.id);
  check.setAttribute('aria-label', `${app.name} 선택`);
  check.dataset.focus = `${app.id}-select`;
  check.addEventListener('change', () => { state.selected.set(app.id, check.checked); counts(); });

  const info = el('div', 'app-info');
  const name = el('div', 'app-name', app.name);
  const rename = button('이름 변경', () => renameItem(app, false), 'rename-button');
  rename.setAttribute('aria-label', `${app.name} 이름 변경`);
  rename.dataset.focus = `${app.id}-rename`;
  name.append(rename);
  const pathLine = el('div', 'app-path', app.path);
  pathLine.title = app.path;
  const tools = el('div', 'app-tools');
  if (app.branch) {
    const branch = el('span', 'branch', `⎇ ${app.branch}`);
    branch.title = `Git 브랜치 ${app.branch}`;
    tools.append(branch);
  }
  for (const [label, target] of [['Finder', 'finder'], ['터미널', 'terminal'], ['VS Code', 'vscode']]) {
    const node = button(label, () => attempt(() => api.openIn(app.id, target)), 'tool-button');
    node.setAttribute('aria-label', `${app.name} ${label}에서 열기`);
    node.disabled = app.missing;
    tools.append(node);
  }
  const badges = el('span', 'badges');
  if (app.options?.waitForPrevious) badges.append(el('span', 'badge', '앞 프로젝트 대기'));
  if (app.options?.autoRestart) badges.append(el('span', 'badge', '자동 재시작'));
  tools.append(badges);
  info.append(name, pathLine, tools);

  const status = el('span', 'status');
  const label = state.waiting.has(app.id) ? '대기 중…' : state.busy.has(app.id) ? '처리 중…'
    : app.missing && !active(app) ? '폴더 없음'
    : app.status === 'running' && !app.ready ? `시작 중 · :${app.port} 대기`
    : ({ running: '준비됨', launching: '시작 중', error: '실행 실패', stopped: '중지됨' }[app.status] || '중지됨');
  const dot = state.waiting.has(app.id) || (app.status === 'running' && !app.ready) ? 'launching' : app.missing && !active(app) ? 'error' : app.status;
  status.append(el('span', `dot ${dot}`), document.createTextNode(label));
  const order = el('span', 'order');
  const up = button('▲', () => attempt(async () => { await api.moveApp(app.id, -1); await refresh(true); }), 'order-button');
  up.setAttribute('aria-label', `${app.name} 위로 이동`);
  up.disabled = position === 0;
  const down = button('▼', () => attempt(async () => { await api.moveApp(app.id, 1); await refresh(true); }), 'order-button');
  down.setAttribute('aria-label', `${app.name} 아래로 이동`);
  down.disabled = position >= total - 1;
  order.append(up, down);
  const handle = el('span', 'drag-handle', '⠿');
  handle.title = '끌어서 순서 변경';
  handle.setAttribute('aria-hidden', 'true');
  sortable(card, handle, 'app', app.id, position, (id, index) => api.placeApp(id, index));
  top.append(handle, check, el('div', 'app-icon', app.name.slice(0, 1).toUpperCase()), info, status, order);

  const bottom = el('div', 'card-bottom');
  const modeArea = el('div', 'mode-area');
  const select = el('select', mode(app) === 'dev' ? '' : 'prod');
  select.setAttribute('aria-label', `${app.name} 실행 환경`);
  select.dataset.focus = `${app.id}-mode`;
  for (const value of modesOf(app)) { const option = el('option', '', upper(value)); option.value = value; select.append(option); }
  select.value = mode(app);
  select.addEventListener('change', () => { state.modes.set(app.id, select.value); render(); });
  const port = active(app) ? app.port : app.ports?.[mode(app)] || app.port;
  modeArea.append(select, el('span', 'port', port ? `:${port}` : '포트 자동 감지'));
  if (active(app) && app.mode && app.mode !== mode(app)) modeArea.append(el('span', '', `현재 ${upper(app.mode)} · 재시작 시 적용`));

  const actions = el('div', 'actions');
  const items = [
    ['열기', () => attempt(() => api.openApp(app.id)), !app.ready || !app.port],
    ['로그', () => showLogs(app), false],
    ['환경 설정', () => attempt(() => editEnv(app)), false],
    [active(app) ? '재시작' : '실행', () => action(app, active(app) ? 'restart' : 'start'), app.missing],
    ['종료', () => action(app, 'stop'), !active(app)],
  ];
  for (const [text, handler, disabled] of items) {
    const node = button(text, handler, text === '실행' ? 'primary' : '');
    node.disabled = disabled || state.busy.has(app.id) || state.waiting.has(app.id);
    node.dataset.focus = `${app.id}-${text}`;
    actions.append(node);
  }
  const remove = button('×', () => removeApp(app));
  remove.setAttribute('aria-label', `${app.name} 등록 해제`);
  remove.title = '등록 해제';
  remove.disabled = active(app) || state.busy.has(app.id);
  actions.append(remove);
  bottom.append(modeArea, actions);
  card.append(top, bottom);
  if (app.missing) {
    const missing = el('div', 'missing-folder');
    missing.append(el('p', 'inline-error', '프로젝트 폴더를 찾을 수 없습니다. 폴더를 옮겼다면 새 위치를 지정해 주세요.'), button('폴더 다시 지정', () => attempt(async () => {
      if (await api.relocateApp(app.id)) { await refresh(true); toast('프로젝트 폴더를 다시 지정했어요.'); }
    })));
    card.append(missing);
  } else if (app.error) {
    const error = el('p', 'inline-error', app.error);
    error.setAttribute('role', 'status');
    if (app.portConflict) {
      const row = el('div', 'missing-folder');
      row.append(error, button('포트 사용 프로세스 보기', () => attempt(() => showPortOwners(app, app.portConflict))));
      card.append(row);
    } else card.append(error);
  }
  return card;
}

// 포트를 점유한 프로세스를 보여 주고, 사용자가 고른 프로세스만 종료한다.
async function showPortOwners(app, port) {
  modal(`${port} 포트 사용 중`, 'PORT CONFLICT');
  const owners = await api.portOwners(port);
  if (!$('modal').open) return;
  if (!owners.length) {
    $('modal-body').append(el('p', '', '지금은 이 포트를 사용하는 프로세스가 없습니다.'));
    submitButton(`${app.name} 실행`, async () => { closeModal(); await action(app, 'start'); });
    return;
  }
  $('modal-body').append(el('p', 'help', '런처 밖에서 실행된 프로세스입니다. 종료하면 해당 프로그램의 저장하지 않은 작업이 사라질 수 있습니다.'));
  for (const owner of owners) {
    const row = el('div', 'env-row port-owner');
    const info = el('div', 'app-info');
    info.append(el('strong', 'env-key', `${owner.name} · PID ${owner.pid}`), el('div', 'base-value', owner.command));
    row.append(info, button('종료', () => attempt(async () => {
      await api.stopPortOwner(port, owner.pid);
      toast(`${owner.name}(PID ${owner.pid})을(를) 종료했어요.`);
      await showPortOwners(app, port);
    }), 'danger'));
    $('modal-body').append(row);
  }
}

async function action(app, command) {
  if (state.busy.has(app.id)) return;
  state.busy.add(app.id);
  render();
  try { await api[command](app.id, mode(app)); }
  catch (error) { toast(`${app.name} · ${error.message}`, true); }
  finally { state.busy.delete(app.id); await refresh(true); }
}

// 선택 실행은 목록 순서대로 진행한다. 앞 프로젝트 대기 옵션이 켜진 프로젝트는 앞 프로젝트의 포트가 열릴 때까지 기다린다.
async function startSelected() {
  const apps = (currentGroup()?.apps || []).filter((app) => state.selected.get(app.id));
  let previous = null, last = Promise.resolve();
  for (const app of apps) {
    const command = active(app) && app.mode !== mode(app) ? 'restart' : 'start';
    if (app.options?.waitForPrevious && previous) {
      const before = previous, gate = last;
      state.waiting.add(app.id); render();
      last = (async () => {
        try { await gate; await api.waitReady(before.id); }
        catch (error) { toast(`${app.name} · ${error.message}`, true); return; }
        finally { state.waiting.delete(app.id); }
        await action(app, command);
      })();
    } else last = action(app, command);
    previous = app;
  }
  await last;
}

function modal(title, eyebrow = 'WORKSPACE SETTINGS') {
  resetLogs();
  state.modalRevision = (state.modalRevision || 0) + 1;
  $('modal-title').textContent = title;
  $('modal-eyebrow').textContent = eyebrow;
  $('modal-body').replaceChildren();
  $('modal-actions').replaceChildren(button('닫기', closeModal));
  if (!$('modal').open) $('modal').showModal();
}
function closeModal() { $('modal').close(); state.logs = null; }
function field(label, value = '', placeholder = '') {
  const wrapper = el('label', 'field', label);
  const input = el('input');
  input.value = value;
  input.placeholder = placeholder;
  wrapper.append(input);
  return { wrapper, input };
}
function checkField(label, checked, help) {
  const wrapper = el('div', 'option-field');
  const labelNode = el('label', 'check-label');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  labelNode.append(input, document.createTextNode(label));
  wrapper.append(labelNode);
  if (help) wrapper.append(el('p', 'help', help));
  return { wrapper, input };
}
function submitButton(label, handler) {
  const node = button(label, async () => {
    node.disabled = true;
    try { await handler(); }
    catch (error) { toast(error.message || String(error), true); }
    finally { node.disabled = false; }
  }, 'primary');
  $('modal-actions').append(node);
  return node;
}
function onEnter(input, handler) {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); handler(); }
  });
}

function addGroup() {
  modal('새 프로젝트 그룹');
  const name = field('그룹 이름', '', '예. 쇼핑몰 서비스');
  $('modal-body').append(name.wrapper);
  const save = submitButton('그룹 만들기', async () => {
    if (!name.input.value.trim()) { name.input.focus(); return; }
    const result = await api.addGroup(name.input.value.trim());
    state.group = result?.id || null;
    closeModal();
    await refresh(true);
  });
  onEnter(name.input, () => save.click());
  name.input.focus();
}
function removeGroup(group) {
  modal('그룹 삭제');
  $('modal-body').append(el('p', 'help', `${group.name} 그룹과 등록된 프로젝트 ${group.apps.length}개를 목록에서 제거합니다. 실행 중인 서버는 종료됩니다. 프로젝트 폴더와 원본 환경 파일은 유지됩니다.`));
  submitButton('그룹 삭제', async () => {
    await api.removeGroup(group.id);
    state.group = null;
    closeModal();
    await refresh(true);
    toast('그룹을 삭제했어요.');
  });
}

function scriptField(label, selected, available = [], manual = false) {
  const wrapper = el('div', 'script-field');
  const selectLabel = el('label', 'field', label);
  const input = el('select');
  input.setAttribute('aria-label', label);
  for (const key of [...new Set(['', ...available, ...(!manual && selected ? [selected] : [])])]) {
    const option = el('option', '', key || '스크립트 선택');
    option.value = key;
    input.append(option);
  }
  const custom = el('option', '', '직접 입력');
  custom.value = '__manual__';
  input.append(custom);
  const command = field(`${label} 직접 입력`, manual ? selected : '', 'sh ./start.sh');
  command.input.spellcheck = false;
  input.value = manual || !available.length ? '__manual__' : selected;
  const update = () => { command.wrapper.hidden = input.value !== '__manual__'; };
  input.addEventListener('change', () => { update(); if (!command.wrapper.hidden) command.input.focus(); });
  update();
  selectLabel.append(input);
  wrapper.append(selectLabel, command.wrapper);
  return {
    wrapper,
    get value() { return (input.value === '__manual__' ? command.input.value : input.value).trim(); },
    get manual() { return input.value === '__manual__'; },
  };
}

async function addApp() {
  await attempt(async () => {
    const groupId = state.group;
    const config = await api.chooseProject();
    if (!config) return;
    modal('프로젝트 연결', 'PROJECT SETUP');
    const name = field('프로젝트 이름', config.name || '');
    const dev = scriptField('DEV 실행 스크립트', config.scripts?.dev || '', config.availableScripts);
    const prod = scriptField('PROD 실행 스크립트', config.scripts?.prod || '', config.availableScripts);
    const devEnv = field('DEV 환경 파일', config.envFiles?.dev || '', '.env.development');
    const prodEnv = field('PROD 환경 파일', config.envFiles?.prod || '', '.env.production');
    const commands = el('div', 'field-grid');
    commands.append(dev.wrapper, prod.wrapper);
    const envs = el('div', 'field-grid');
    envs.append(devEnv.wrapper, prodEnv.wrapper);
    $('modal-body').append(
      el('p', 'help', config.path), name.wrapper, commands, envs,
      el('p', 'help', '감지된 스크립트를 선택하거나 직접 입력하세요. 명령은 선택한 프로젝트 폴더에서 실행됩니다. 환경 파일은 .env 형식의 프로젝트 기준 상대 경로를 입력하세요. 다른 환경은 연결 후 환경 설정에서 추가할 수 있습니다.'),
    );
    submitButton('프로젝트 연결', async () => {
      if (!name.input.value.trim() || !dev.value) throw new Error('프로젝트 이름과 DEV 실행 명령을 입력해 주세요.');
      await api.addApp(groupId, {
        ...config, name: name.input.value.trim(),
        scripts: { dev: dev.value, prod: prod.value },
        manualScripts: { dev: dev.manual, prod: prod.manual },
        envFiles: { dev: devEnv.input.value.trim(), prod: prodEnv.input.value.trim() },
      });
      closeModal();
      await refresh(true);
    });
  });
}

function renameItem(item, isGroup) {
  modal(isGroup ? '그룹 이름 변경' : '프로젝트 이름 변경');
  const name = field(isGroup ? '그룹 이름' : '프로젝트 이름', item.name);
  const error = el('p', 'inline-error');
  error.setAttribute('role', 'alert');
  $('modal-body').append(name.wrapper, error);
  const save = submitButton('이름 저장', async () => {
    if (!name.input.value.trim()) { error.textContent = '이름을 입력해 주세요.'; name.input.focus(); return; }
    await api[isGroup ? 'renameGroup' : 'renameApp'](item.id, name.input.value.trim());
    closeModal();
    await refresh(true);
    toast('이름을 변경했어요.');
  });
  onEnter(name.input, () => save.click());
  name.input.focus();
  name.input.select();
}
function removeApp(app) {
  modal('프로젝트 등록 해제');
  $('modal-body').append(el('p', 'help', `${app.name}을(를) 이 그룹에서 제거합니다. 프로젝트 폴더와 원본 환경 파일은 유지됩니다.`));
  submitButton('등록 해제', async () => { await api.removeApp(app.id); closeModal(); await refresh(true); });
}

// 터미널 색상 코드를 화면 색상으로 바꾸고, 커서 이동 같은 나머지 제어 문자는 제거한다.
const ANSI = /\x1b\[([\d;]*)m|\x1b\[[\d;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r/g;
const stripAnsi = (text) => text.replace(ANSI, '');
const LOG_LIMIT = 5000;
const plainStyle = () => ({ bold: false, fg: null, bg: null });
// style은 이어지는 줄에도 색상이 유지되도록 호출 간에 공유한다.
function renderAnsi(text, target, style) {
  let last = 0;
  const push = (chunk) => {
    if (!chunk) return;
    if (!style.bold && !style.fg && !style.bg) { target.append(chunk); return; }
    const classes = [style.bold && 'ansi-b', style.fg && `ansi-fg-${style.fg}`, style.bg && `ansi-bg-${style.bg}`].filter(Boolean).join(' ');
    target.append(el('span', classes, chunk));
  };
  for (const match of text.matchAll(ANSI)) {
    push(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[1] === undefined) continue;
    const codes = match[1] === '' ? [0] : match[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      if (code === 0) { style.bold = false; style.fg = null; style.bg = null; }
      else if (code === 1) style.bold = true;
      else if (code === 22) style.bold = false;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) style.fg = code;
      else if (code === 39) style.fg = null;
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) style.bg = code;
      else if (code === 49) style.bg = null;
      else if (code === 38 || code === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
    }
  }
  push(text.slice(last));
}
function resetLogs() { state.logs = null; state.logLines = []; state.logPartial = ''; state.logCursor = null; }
const logContent = () => [...state.logLines, state.logPartial].join('\n');
const logMatches = (line) => {
  const filter = state.logFilter.trim().toLowerCase();
  return !filter || stripAnsi(line).toLowerCase().includes(filter);
};
// lines를 주면 기존 출력 뒤에 덧붙이고, 없으면 전체를 다시 그린다.
function drawLogs(lines) {
  const output = $('log-output');
  if (!output) return;
  const body = $('modal-body');
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 70;
  if (!lines || output.dataset.placeholder) { output.replaceChildren(); delete output.dataset.placeholder; state.logStyle = plainStyle(); lines = state.logLines; }
  output.querySelector('.log-partial')?.remove();
  for (const line of lines) if (logMatches(line)) renderAnsi(`${line}\n`, output, state.logStyle);
  if (state.logPartial && logMatches(state.logPartial)) {
    const partial = el('span', 'log-partial');
    renderAnsi(state.logPartial, partial, { ...state.logStyle });
    output.append(partial);
  }
  if (!output.childNodes.length) {
    output.textContent = state.logLines.length || state.logPartial ? '검색 결과가 없습니다.' : '아직 출력된 로그가 없습니다.';
    output.dataset.placeholder = '1';
  }
  if (atBottom) body.scrollTop = body.scrollHeight;
}
// 종료·재시작 직전까지의 로그를 보여 준다. 다시 갱신되지 않는 보관본이다.
function showPreviousLogs(app, previous) {
  modal(`${app.name} 직전 실행 로그`, `${upper(previous.mode)} / ${new Date(previous.endedAt).toLocaleTimeString()} 종료`);
  const tools = el('div', 'log-tools');
  tools.append(
    button('현재 로그', () => { void showLogs(app); }),
    button('복사', () => attempt(async () => { await api.copyText(stripAnsi(previous.text)); toast('직전 실행 로그를 복사했어요.'); })),
  );
  const output = el('pre', 'log-output');
  renderAnsi(previous.text, output, plainStyle());
  $('modal-body').append(tools, output);
  $('modal-body').scrollTop = $('modal-body').scrollHeight;
}
async function showLogs(app) {
  modal(`${app.name} 로그`, `${upper(app.mode || mode(app))} / PROCESS OUTPUT`);
  const tools = el('div', 'log-tools');
  const search = el('input');
  search.type = 'search';
  search.placeholder = '로그 검색';
  search.setAttribute('aria-label', '로그 검색');
  search.value = state.logFilter;
  search.addEventListener('input', () => { state.logFilter = search.value; drawLogs(); });
  const copy = button('복사', () => attempt(async () => { await api.copyText(stripAnsi(logContent())); toast('로그를 복사했어요.'); }));
  const clear = button('지우기', () => attempt(async () => { await api.clearLogs(app.id); state.logCursor = null; await refreshLogs(); }));
  tools.append(search, copy, clear);
  const previous = await api.previousLogs(app.id);
  if (previous) tools.append(button('직전 실행 로그', () => showPreviousLogs(app, previous)));
  const output = el('pre', 'log-output', '로그 불러오는 중…');
  output.id = 'log-output';
  $('modal-body').append(tools, output);
  state.logs = app.id;
  await attempt(async () => {
    await refreshLogs();
    $('modal-body').scrollTop = $('modal-body').scrollHeight;
  });
}

// 환경 설정은 탭으로 나누고, 창 안에서 편집할 실행 환경을 바꿀 수 있다.
async function editEnv(app, selectedMode = mode(app), initialTab) {
  modal(`${app.name} 환경 설정`, `${upper(selectedMode)} / LOCAL OVERRIDES`);
  $('modal-body').append(el('p', 'help', '환경 설정 불러오는 중…'));
  const revision = state.modalRevision;
  const data = await api.env(app.id, selectedMode);
  if (!$('modal').open || state.modalRevision !== revision) return;
  $('modal-body').replaceChildren();
  const container = el('div', 'env-editor');
  $('modal-body').append(container);
  let dirty = false, currentTab = initialTab || (data.envFileMissing ? 'run' : 'env');
  const markDirty = (event) => { if (!event.target.closest('[data-instant]')) dirty = true; };
  container.addEventListener('input', markDirty);
  container.addEventListener('change', markDirty);

  const switchRow = el('div', 'env-switch');
  const switchLabel = el('label', 'check-label', '편집할 환경');
  const switcher = el('select');
  switcher.setAttribute('aria-label', '편집할 환경');
  switchLabel.append(switcher);
  switchRow.dataset.instant = '1';
  switchRow.append(switchLabel);
  const drawSwitcher = (modes) => {
    switcher.replaceChildren(...modes.map((name) => { const option = el('option', '', upper(name)); option.value = name; return option; }));
    switcher.value = selectedMode;
  };
  switcher.addEventListener('change', () => {
    if (dirty && !window.confirm('저장하지 않은 변경 사항이 사라집니다. 편집할 환경을 바꿀까요?')) { switcher.value = selectedMode; return; }
    void attempt(() => editEnv(app, switcher.value, currentTab));
  });

  const tabList = el('div', 'tabs');
  tabList.setAttribute('role', 'tablist');
  const panels = {};
  const showTab = (name) => {
    currentTab = name;
    for (const [key, item] of Object.entries(panels)) { item.tab.setAttribute('aria-selected', String(key === name)); item.panel.hidden = key !== name; }
  };
  for (const [key, label] of [['env', '환경변수'], ['run', '실행 명령'], ['modes', '환경·옵션'], ['tunnel', 'SSH 터널']]) {
    const tab = button(label, () => showTab(key), 'tab');
    tab.setAttribute('role', 'tab');
    const panel = el('div', 'tab-panel');
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-label', label);
    panels[key] = { tab, panel };
    tabList.append(tab);
  }
  container.append(switchRow, tabList, ...Object.values(panels).map((item) => item.panel));
  const panel = (key) => panels[key].panel;

  const overrides = Object.assign(Object.create(null), data.overrides);
  const drafts = Object.assign(Object.create(null), data.drafts, data.overrides);
  const bases = new Map(data.base.map(({ key, value }) => [key, value]));
  const keys = [...new Set([...bases.keys(), ...Object.keys(drafts), ...Object.keys(overrides)])];
  // 같은 그룹에서 포트를 아는 다른 프로젝트를 API 주소 후보로 쓴다. 실행 중인 프로젝트를 먼저 보여 준다.
  const siblings = state.groups.find((group) => group.apps.some((item) => item.id === app.id))?.apps || [];
  const localTargets = siblings.filter((item) => item.id !== app.id)
    .map((item) => ({ name: item.name, running: active(item), port: active(item) ? item.port : item.ports?.[mode(item)] || item.port }))
    .filter((item) => item.port)
    .sort((a, b) => Number(b.running) - Number(a.running));

  const script = scriptField(`${upper(selectedMode)} 실행 스크립트`, data.script, data.availableScripts, data.manualScript);
  const envFile = field(`${upper(selectedMode)} 환경 파일`, data.envFile || '', '.env.development');
  envFile.input.spellcheck = false;
  const missing = el('p', 'inline-error', data.envFileMissing ? `환경 파일 ${data.envFile}을(를) 찾을 수 없습니다. 경로를 고친 뒤 저장해 주세요.` : '');
  missing.setAttribute('role', 'alert');
  missing.hidden = !data.envFileMissing;
  panel('run').append(
    script.wrapper, envFile.wrapper, missing,
    el('p', 'help', '감지된 스크립트를 선택하거나 sh ./start.sh처럼 직접 입력하세요. 명령은 프로젝트 폴더에서 실행되며 다음 실행 또는 재시작부터 적용됩니다. 환경 파일은 프로젝트 기준 상대 경로입니다.'),
  );

  // 실행 환경 추가·삭제와 프로젝트 옵션은 저장 버튼과 별개로 바로 반영된다.
  const modesSection = el('section', 'option-section');
  modesSection.append(el('h3', '', '실행 환경'));
  const modeList = el('div', 'mode-list');
  const drawModes = (modes) => {
    drawSwitcher(modes);
    modeList.replaceChildren(...modes.map((name) => {
      const chip = el('span', 'mode-chip', upper(name));
      if (name !== 'dev') {
        const remove = button('×', () => attempt(async () => {
          const next = await api.removeMode(app.id, name);
          toast(`${upper(name)} 환경을 삭제했어요.`);
          await refresh(true);
          if (name === selectedMode) await editEnv(app, 'dev', 'modes');
          else drawModes(next);
        }), 'chip-remove');
        remove.setAttribute('aria-label', `${upper(name)} 환경 삭제`);
        chip.append(remove);
      }
      return chip;
    }));
  };
  drawModes(data.modes || DEFAULT_MODES);
  const newModeRow = el('div', 'new-key-row');
  const newMode = el('input');
  newMode.placeholder = '새 환경 이름 (예. staging)';
  newMode.setAttribute('aria-label', '새 환경 이름');
  const addMode = () => attempt(async () => {
    const name = newMode.value.trim().toLowerCase();
    const next = await api.addMode(app.id, name);
    newMode.value = '';
    drawModes(next);
    toast(`${upper(name)} 환경을 추가했어요. 위의 편집할 환경에서 선택해 실행 스크립트를 설정하세요.`);
    await refresh(true);
  });
  onEnter(newMode, addMode);
  newModeRow.append(newMode, button('＋ 환경 추가', addMode));
  modesSection.dataset.instant = '1';
  modesSection.append(modeList, newModeRow, el('p', 'help', '환경 추가·삭제는 바로 반영됩니다. 환경마다 실행 스크립트, 환경 파일, 개인 환경값, SSH 터널을 따로 저장합니다. DEV는 삭제할 수 없습니다.'));
  panel('modes').append(modesSection);

  const optionSection = el('section', 'option-section');
  optionSection.append(el('h3', '', '프로젝트 옵션'));
  const waitOption = checkField('앞 프로젝트 준비 후 실행', data.options?.waitForPrevious === true, '선택 실행 시 목록에서 바로 앞 프로젝트의 포트가 열릴 때까지 기다린 뒤 시작합니다.');
  const restartOption = checkField('비정상 종료 시 자동 재시작', data.options?.autoRestart === true, '프로세스가 예기치 않게 종료되면 알림을 보내고 연속 3회까지 다시 시작합니다.');
  optionSection.append(waitOption.wrapper, restartOption.wrapper);
  panel('modes').append(optionSection);

  const tunnelSection = el('section', 'tunnel-settings');
  const tunnelLabel = el('label', 'check-label');
  const tunnelEnabled = el('input');
  tunnelEnabled.type = 'checkbox';
  tunnelEnabled.checked = data.tunnel?.enabled === true;
  tunnelLabel.append(tunnelEnabled, document.createTextNode('SSH 터널 사용'));
  tunnelSection.append(tunnelLabel, el('p', 'help', '프로젝트 실행 전에 터널을 연결하고, 프로젝트 종료 시 함께 닫습니다. 현재 실행 환경에만 저장됩니다.'));
  const tunnelFields = el('div');
  tunnelFields.id = 'tunnel-fields';
  tunnelFields.hidden = !tunnelEnabled.checked;
  tunnelEnabled.setAttribute('aria-controls', tunnelFields.id);
  tunnelEnabled.addEventListener('change', () => { tunnelFields.hidden = !tunnelEnabled.checked; });
  const keyPath = field('PEM 키 경로', data.tunnel?.keyPath || '', '/경로/development.pem');
  const keyRow = el('div', 'tunnel-key-row');
  keyRow.append(keyPath.wrapper, button('키 파일 선택', () => attempt(async () => {
    const selected = await api.choosePem();
    if (selected) keyPath.input.value = selected;
  })));
  tunnelFields.append(keyRow, el('p', 'help', '키 파일은 복사하지 않고 이 Mac의 경로만 저장합니다.'));
  const tunnelInputs = { keyPath: keyPath.input };
  const tunnelGrid = el('div', 'field-grid');
  const tunnelSpec = [
    ['host', 'SSH 서버 주소', '', 'bastion.example.com'], ['user', 'SSH 사용자', '', 'ubuntu'], ['sshPort', 'SSH 포트', 22, ''],
    ['localPort', '로컬 포트', 13316, ''], ['remoteHost', '원격 DB 주소', '', 'db.internal'], ['remotePort', '원격 DB 포트', 3306, ''],
  ];
  for (const [name, label, fallback, placeholder] of tunnelSpec) {
    const item = field(label, data.tunnel?.[name] ?? fallback, placeholder);
    if (name.endsWith('Port')) { item.input.type = 'number'; item.input.min = '1'; item.input.max = '65535'; item.input.step = '1'; }
    tunnelInputs[name] = item.input;
    tunnelGrid.append(item.wrapper);
  }
  tunnelFields.append(tunnelGrid, button('DB 주소 적용', () => {
    if (!tunnelInputs.localPort.reportValidity() || !tunnelInputs.localPort.value) { toast('로컬 포트는 1~65535 사이의 정수로 입력해 주세요.', true); return; }
    overrides.DB_HOST = '127.0.0.1';
    overrides.DB_PORT = tunnelInputs.localPort.value;
    for (const key of ['DB_HOST', 'DB_PORT']) if (!keys.includes(key)) keys.push(key);
    filter.value = '';
    drawRows();
    showTab('env');
    toast('DB_HOST와 DB_PORT에 로컬 접속 주소를 입력했어요. 설정을 저장해 주세요.');
  }), el('p', 'help', 'DB 주소 적용을 누르면 DB_HOST=127.0.0.1, DB_PORT=로컬 포트를 개인 환경변수로 설정합니다. 원본 환경 파일은 수정하지 않습니다.'));
  tunnelSection.append(tunnelFields);
  panel('tunnel').append(tunnelSection);

  panel('env').append(el('p', 'help', '기본 환경 파일 위에 개인 설정을 적용합니다. 체크를 끄면 기본값을 사용하며 직접 입력한 값은 다음 사용을 위해 보관합니다. 체크한 채 비워두면 빈 문자열을 적용합니다.'));
  const tools = el('div', 'env-tools');
  const filter = el('input');
  filter.type = 'search';
  filter.placeholder = '환경변수 검색';
  filter.setAttribute('aria-label', '환경변수 검색');
  const revealLabel = el('label', 'check-label');
  const reveal = el('input');
  reveal.type = 'checkbox';
  reveal.checked = true;
  revealLabel.append(reveal, document.createTextNode('값 표시'));
  tools.append(filter, revealLabel);
  const rows = el('div');
  panel('env').append(tools, rows);
  function drawRows() {
    rows.replaceChildren();
    const matching = keys.filter((key) => key.toLowerCase().includes(filter.value.toLowerCase()));
    if (!matching.length) rows.append(el('p', 'help', keys.length ? '검색 결과가 없습니다.' : '환경변수가 없습니다. 아래에서 새 변수를 추가하세요.'));
    for (const key of matching) {
      const row = el('div', 'env-row');
      const baseText = bases.has(key) ? (reveal.checked ? bases.get(key) || '(빈 값)' : '••••••••') : '(새 변수)';
      row.append(el('strong', 'env-key', key), el('div', 'base-value', `기본값 · ${baseText}`));
      const controls = el('div', 'override-controls');
      const label = el('label', 'check-label');
      const toggle = el('input');
      toggle.type = 'checkbox';
      toggle.checked = Object.hasOwn(overrides, key);
      label.append(toggle, document.createTextNode('직접 설정'));
      const value = el('input');
      value.type = reveal.checked ? 'text' : 'password';
      value.autocomplete = 'off';
      value.spellcheck = false;
      value.value = overrides[key] ?? drafts[key] ?? '';
      value.disabled = !toggle.checked;
      value.placeholder = toggle.checked ? '빈 값으로 적용' : '기본값 사용';
      value.setAttribute('aria-label', `${key} 개인 설정`);
      toggle.addEventListener('change', () => {
        drafts[key] = value.value;
        value.disabled = !toggle.checked;
        value.placeholder = toggle.checked ? '빈 값으로 적용' : '기본값 사용';
        if (toggle.checked) { overrides[key] = value.value; value.focus(); } else delete overrides[key];
      });
      value.addEventListener('input', () => { drafts[key] = value.value; overrides[key] = value.value; });
      controls.append(label, value);
      row.append(controls);
      if (/API.*(URL|HOST)|BASE.*URL|API_URL/i.test(key)) {
        const fill = (address) => {
          toggle.checked = true; value.disabled = false; value.value = address; value.type = 'text';
          drafts[key] = address; overrides[key] = address; value.focus(); value.select();
        };
        if (localTargets.length) {
          const picker = el('select', 'quick-api');
          picker.setAttribute('aria-label', `${key} 로컬 주소 선택`);
          const placeholder = el('option', '', '로컬 주소 입력…');
          placeholder.value = '';
          picker.append(placeholder, ...localTargets.map((target) => {
            const option = el('option', '', `${target.name} · :${target.port}${target.running ? ' (실행 중)' : ''}`);
            option.value = `http://localhost:${target.port}`;
            return option;
          }));
          picker.addEventListener('change', () => { if (picker.value) fill(picker.value); picker.value = ''; });
          row.append(picker);
        } else row.append(button('로컬 주소 입력', () => fill('http://localhost:8080'), 'quick-api'));
      }
      rows.append(row);
    }
  }
  filter.addEventListener('input', drawRows);
  reveal.addEventListener('change', drawRows);
  drawRows();
  const newKeyRow = el('div', 'new-key-row');
  const newKey = el('input');
  newKey.placeholder = '새 환경변수 이름';
  newKey.setAttribute('aria-label', '새 환경변수 이름');
  newKeyRow.append(newKey, button('＋ 변수 추가', () => {
    const key = newKey.value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { toast('영문, 숫자, 밑줄로 변수 이름을 입력해 주세요.', true); return; }
    if (keys.includes(key)) { toast('이미 등록된 변수입니다.', true); return; }
    keys.push(key); overrides[key] = ''; newKey.value = ''; filter.value = '';
    drawRows();
  }));
  panel('env').append(newKeyRow);
  showTab(currentTab);

  const save = async (restart) => {
    if (tunnelEnabled.checked) for (const input of Object.values(tunnelInputs)) { input.required = true; if (!input.checkValidity()) { showTab('tunnel'); input.reportValidity(); return; } }
    const tunnel = {
      enabled: tunnelEnabled.checked,
      ...Object.fromEntries(Object.entries(tunnelInputs).map(([key, input]) => [key, key.endsWith('Port') ? Number(input.value) : input.value.trim()])),
    };
    await api.saveEnv(app.id, selectedMode, overrides, script.value || (script.manual ? '' : undefined), tunnel, drafts, script.manual);
    if (envFile.input.value.trim() !== (data.envFile || '')) await api.setEnvFile(app.id, selectedMode, envFile.input.value.trim());
    await api.setAppOptions(app.id, { waitForPrevious: waitOption.input.checked, autoRestart: restartOption.input.checked });
    if (restart) { await api.restart(app.id, selectedMode); state.modes.set(app.id, selectedMode); }
    closeModal();
    toast(restart ? '환경을 저장하고 다시 시작했어요.' : '개인 환경 설정을 저장했어요.');
    await refresh(true);
  };
  submitButton('설정 저장', () => save(false));
  if (active(app)) submitButton(app.mode && app.mode !== selectedMode ? `저장 후 ${upper(selectedMode)}로 재시작` : '저장 후 재시작', () => save(true));
}

$('rename-group').addEventListener('click', () => { const group = currentGroup(); if (group) renameItem(group, true); });
$('remove-group').addEventListener('click', () => { const group = currentGroup(); if (group) removeGroup(group); });
$('group-up').addEventListener('click', () => attempt(async () => { if (state.group) { await api.moveGroup(state.group, -1); await refresh(true); } }));
$('group-down').addEventListener('click', () => attempt(async () => { if (state.group) { await api.moveGroup(state.group, 1); await refresh(true); } }));
$('add-group').addEventListener('click', addGroup);
$('add-app').addEventListener('click', addApp);
$('close-modal').addEventListener('click', closeModal);
$('modal').addEventListener('close', resetLogs);
$('group-mode').addEventListener('change', () => {
  const value = $('group-mode').value;
  if (value === 'mixed') return;
  for (const app of currentGroup()?.apps || []) if (modesOf(app).includes(value)) state.modes.set(app.id, value);
  render();
  toast(`${upper(value)} 환경을 선택했어요. 다음 실행 또는 재시작 시 적용됩니다.`);
});
$('start-selected').addEventListener('click', () => { void startSelected(); });
$('stop-all').addEventListener('click', () => { void Promise.all((currentGroup()?.apps || []).filter(active).map((app) => action(app, 'stop'))); });
api.onChange(() => { void attempt(() => refresh()); });
void attempt(() => refresh(true));
setInterval(() => { void attempt(() => refresh()); }, 5000);
setInterval(() => { void attempt(() => refreshLogs()); }, 1000);

$('auto-open').addEventListener('change', async () => {
  const checkbox = $('auto-open');
  checkbox.disabled = true;
  try { await api.setAutoOpen(checkbox.checked); toast(checkbox.checked ? '실행 후 브라우저가 자동으로 열립니다.' : '브라우저 자동 열기를 껐어요.'); }
  catch (error) { checkbox.checked = !checkbox.checked; toast(error.message, true); }
  finally { checkbox.disabled = false; }
});

// 자주 쓰지 않는 앱 전체 설정은 사이드바 대신 앱 설정 창에 모은다.
function openAppSettings() {
  modal('앱 설정', 'DEV LAUNCHER');
  const general = el('section', 'option-section');
  general.append(el('h3', '', '실행과 알림'));
  const tray = checkField('메뉴 바 상주', state.trayMode === true, '창을 닫아도 서버를 유지하고, 메뉴 바 아이콘에서 실행 상태 확인과 실행·종료·열기를 할 수 있습니다.');
  tray.input.addEventListener('change', async () => {
    tray.input.disabled = true;
    try {
      await api.setTrayMode(tray.input.checked);
      state.trayMode = tray.input.checked;
      toast(tray.input.checked ? '메뉴 바에 상주합니다. 창을 닫아도 서버가 유지됩니다.' : '메뉴 바 상주를 껐어요. 창을 닫으면 서버도 종료됩니다.');
    } catch (error) { tray.input.checked = !tray.input.checked; toast(error.message, true); }
    finally { tray.input.disabled = false; }
  });
  const notify = checkField('준비 완료 알림', state.readyNotify === true, '서버 포트가 열리면 macOS 알림을 보냅니다. 빌드가 오래 걸리는 프로젝트에 유용합니다.');
  notify.input.addEventListener('change', async () => {
    notify.input.disabled = true;
    try {
      await api.setReadyNotify(notify.input.checked);
      state.readyNotify = notify.input.checked;
      toast(notify.input.checked ? '서버가 준비되면 알림을 보냅니다.' : '준비 완료 알림을 껐어요.');
    } catch (error) { notify.input.checked = !notify.input.checked; toast(error.message, true); }
    finally { notify.input.disabled = false; }
  });
  general.append(tray.wrapper, notify.wrapper);

  const config = el('section', 'option-section');
  config.append(el('h3', '', '설정 파일'));
  const tools = el('div', 'config-tools');
  tools.append(
    button('내보내기', () => attempt(async () => {
      const file = await api.exportConfig();
      if (file) toast('그룹 구성을 내보냈어요. 개인 환경값과 SSH 키 경로는 포함하지 않습니다.');
    })),
    button('가져오기', () => attempt(async () => {
      const result = await api.importConfig();
      if (!result) return;
      await refresh(true);
      const skipped = result.skipped.length ? ` 건너뜀 ${result.skipped.length}개: ${result.skipped.join(' / ')}` : '';
      toast(`그룹 ${result.groups}개, 프로젝트 ${result.apps}개를 가져왔어요.${skipped}`, result.skipped.length > 0);
    })),
  );
  config.append(tools, el('p', 'help', '내보내기는 그룹과 프로젝트 구성을 JSON으로 저장하며 개인 환경값과 SSH 설정은 제외합니다. 가져오기는 파일의 그룹을 새 그룹으로 추가합니다.'));

  const restart = el('section', 'option-section');
  restart.append(el('h3', '', '앱 재시작'), el('p', 'help', '런처에서 실행한 서버를 모두 종료한 뒤 런처를 다시 엽니다.'), button('앱 재시작', confirmRestart));
  $('modal-body').append(general, config, restart);
}
$('app-settings').addEventListener('click', openAppSettings);

async function restartApp() {
  try { await api.restartApp(); }
  catch (error) { toast(error.message, true); }
}
// 실행 중인 서버가 있으면 종료된다는 점을 확인받은 뒤 재시작한다.
function confirmRestart() {
  const running = state.groups.flatMap((group) => group.apps).filter(active).length;
  if (!running) { closeModal(); void restartApp(); return; }
  modal('앱 재시작', 'DEV LAUNCHER');
  $('modal-body').append(el('p', 'help', `실행 중인 서버 ${running}개를 종료한 뒤 런처를 다시 엽니다.`));
  submitButton('종료 후 재시작', async () => { closeModal(); await restartApp(); });
}

let updateView = false, updateSignature = '', updateChecking = false, latestUpdate = null;
function renderUpdateStatus(update) {
  latestUpdate = update;
  $('update-summary').textContent = `v${update.currentVersion}`;
  $('update-notice').hidden = !['available', 'downloaded'].includes(update.phase);
  $('update-notice-text').textContent = update.phase === 'downloaded' ? `v${update.version} 설치 준비 완료` : `새 업데이트 v${update.version}`;
  if (updateChecking) update = { ...update, phase: 'checking', message: '업데이트를 확인하고 있습니다.' };
  if (!updateView || !$('modal').open) return;
  const signature = JSON.stringify(update);
  if (signature === updateSignature) return;
  updateSignature = signature;
  $('modal-body').replaceChildren(el('p', 'help', `현재 버전 ${update.currentVersion}`), el('p', '', update.message || '새로운 버전이 있는지 확인할 수 있습니다.'));
  if (update.phase === 'downloading') {
    const progress = el('progress');
    progress.max = 100;
    progress.value = update.progress;
    progress.setAttribute('aria-label', '업데이트 다운로드');
    $('modal-body').append(progress, el('p', 'help', `${Math.round(update.progress)}%`));
  }
  if (update.phase === 'downloaded') $('modal-body').append(el('p', 'help', '설치 시 실행 중인 서버가 종료됩니다. 프로젝트 등록과 개인 환경 설정은 유지됩니다.'));
  $('modal-actions').replaceChildren(button('닫기', closeModal));
  if (['current', 'checking', 'downloading'].includes(update.phase)) return;
  const operation = update.phase === 'available' ? ['업데이트 다운로드', 'downloadUpdate']
    : update.phase === 'downloaded' ? ['설치 후 재시작', 'installUpdate'] : ['업데이트 확인', 'checkUpdate'];
  submitButton(operation[0], async () => {
    if (operation[1] === 'checkUpdate') { await openUpdate(); return; }
    await api[operation[1]]();
    updateSignature = '';
    renderUpdateStatus(await api.updateStatus());
  });
}
async function openUpdate(check = true) {
  modal('앱 업데이트', 'DEV LAUNCHER');
  updateView = true;
  updateSignature = '';
  if (!check || updateChecking || ['checking', 'downloading', 'downloaded'].includes(latestUpdate?.phase)) {
    if (latestUpdate) renderUpdateStatus(latestUpdate);
    return;
  }
  updateChecking = true;
  if (latestUpdate) renderUpdateStatus(latestUpdate);
  else $('modal-body').append(el('p', '', '업데이트를 확인하고 있습니다.'));
  try { await api.checkUpdate(); }
  finally { updateChecking = false; updateSignature = ''; renderUpdateStatus(await api.updateStatus()); }
}
$('updates').addEventListener('click', () => { void attempt(() => openUpdate()); });
$('open-update').addEventListener('click', () => { void attempt(() => openUpdate(false)); });
$('modal').addEventListener('close', () => { updateView = false; updateSignature = ''; });
