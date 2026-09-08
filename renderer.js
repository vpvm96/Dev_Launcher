// 프로젝트 실행 상태와 그룹별 환경 편집을 연결하는 데스크톱 화면 로직
const api = window.launcher;
const $ = (id) => document.getElementById(id);
const state = { groups: [], group: null, selected: new Map(), modes: new Map(), busy: new Set(), signature: '', logs: null, refreshing: false };
try {
  const saved = JSON.parse(localStorage.getItem('launcher-selection') || '{}');
  state.group = typeof saved.group === 'string' ? saved.group : null;
  state.selected = new Map((Array.isArray(saved.selected) ? saved.selected : []).filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean'));
  state.modes = new Map((Array.isArray(saved.modes) ? saved.modes : []).filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && ['dev', 'prod'].includes(entry[1])));
} catch { /* 저장된 화면 설정이 손상되었으면 기본 선택을 사용한다. */ }
function persistSelection() {
  try { localStorage.setItem('launcher-selection', JSON.stringify({ group: state.group, selected: [...state.selected], modes: [...state.modes] })); } catch { /* 저장소를 사용할 수 없어도 현재 세션은 계속 동작한다. */ }
}
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const button = (text, handler, cls = '') => { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', handler); return node; };
const currentGroup = () => state.groups.find((group) => group.id === state.group);
const mode = (app) => state.modes.get(app.id) || app.mode || 'dev';
const active = (app) => ['running', 'launching'].includes(app.status);
function toast(message, error = false) { $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 3500); }
async function attempt(fn) { try { return await fn(); } catch (error) { toast(error.message || String(error), true); } }
async function refresh(force = false) {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const data = await api.list(); if (!$('auto-open').disabled) $('auto-open').checked = data.autoOpen; state.groups = data.groups;
    if (!currentGroup()) state.group = state.groups[0]?.id || null;
    for (const group of state.groups) for (const app of group.apps) { if (!state.selected.has(app.id)) state.selected.set(app.id, true); if (!state.modes.has(app.id)) state.modes.set(app.id, app.mode || 'dev'); }
    const signature = JSON.stringify([data.groups, state.group, [...state.busy]]);
    if (force || signature !== state.signature) { state.signature = signature; render(); }
    if (state.logs && $('modal').open) { const content = await api.logs(state.logs); const output = $('log-output'); if (output && output.textContent !== content) { const atBottom = $('modal-body').scrollHeight - $('modal-body').scrollTop - $('modal-body').clientHeight < 70; output.textContent = content || '아직 출력된 로그가 없습니다.'; if (atBottom) $('modal-body').scrollTop = $('modal-body').scrollHeight; } }
  } finally { state.refreshing = false; }
}
function counts() { persistSelection(); const apps = currentGroup()?.apps || []; const selected = apps.filter((app) => state.selected.get(app.id)); $('selection-count').textContent = `${selected.length}개 선택`; $('start-selected').disabled = !selected.length || selected.some((app) => state.busy.has(app.id)); $('stop-all').disabled = !apps.some(active); }
function render() {
  const focusKey = document.activeElement?.dataset.focus;
  $('groups').replaceChildren(...state.groups.map((group) => { const node = button('', () => { state.group = group.id; render(); }, `group-button${group.id === state.group ? ' active' : ''}`); node.append(el('span', '', group.name), el('span', '', String(group.apps.length))); node.setAttribute('aria-current', group.id === state.group ? 'page' : 'false'); return node; }));
  const group = currentGroup(); const apps = group?.apps || [];
  $('group-title').textContent = group?.name || '나의 개발 워크스페이스'; $('group-description').textContent = group ? '필요한 프로젝트를 선택하고 작업을 시작하세요.' : '첫 번째 그룹을 추가해서 시작하세요.';
  $('rename-group').disabled = !group; $('add-app').disabled = !group; $('group-mode').disabled = !group; $('app-count').textContent = String(apps.length); $('running-count').textContent = `${apps.filter(active).length}개 실행 중`;
  const modes = new Set(apps.map(mode)); const mixed = $('group-mode').querySelector('[value=mixed]'); if (mixed) mixed.remove(); if (modes.size > 1) { const option = el('option', '', '개별 설정'); option.value = 'mixed'; $('group-mode').append(option); $('group-mode').value = 'mixed'; } else $('group-mode').value = [...modes][0] || 'dev';
  $('apps').replaceChildren(...apps.map(renderApp));
  if (!apps.length) { const empty = el('div', 'empty'); empty.append(el('h2', '', group ? '프로젝트를 연결해 주세요.' : '작업을 그룹으로 모아보세요.'), el('p', '', group ? '프로젝트 폴더를 선택하면 실행 명령과 환경 파일을 찾아드려요.' : 'Dearmonday, Powderroom처럼 함께 켤 프로젝트를 묶어주세요.'), button(group ? '＋ 프로젝트 폴더 선택' : '＋ 첫 그룹 만들기', group ? addApp : addGroup, 'primary')); $('apps').append(empty); }
  counts(); if (focusKey) [...document.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === focusKey)?.focus({ preventScroll: true });
}
function renderApp(app) {
  const card = el('article', 'app-card'); const top = el('div', 'card-top'); const check = el('input'); check.type = 'checkbox'; check.checked = state.selected.get(app.id); check.setAttribute('aria-label', `${app.name} 선택`); check.dataset.focus = `${app.id}-select`; check.addEventListener('change', () => { state.selected.set(app.id, check.checked); counts(); });
  const info = el('div', 'app-info'); info.append(el('div', 'app-name', app.name), el('div', 'app-path', app.path)); info.lastChild.title = app.path; const rename = button('이름 변경', () => renameItem(app, false), 'rename-button'); rename.setAttribute('aria-label', `${app.name} 이름 변경`); rename.dataset.focus = `${app.id}-rename`; info.firstChild.append(rename);
  const status = el('span', 'status'); status.append(el('span', `dot ${app.status}`), document.createTextNode(state.busy.has(app.id) ? '처리 중…' : ({ running: '실행 중', launching: '시작 중', error: '실행 실패', stopped: '중지됨' }[app.status] || '중지됨')));
  top.append(check, el('div', 'app-icon', app.name.slice(0, 1).toUpperCase()), info, status);
  const bottom = el('div', 'card-bottom'); const modeArea = el('div', 'mode-area'); const select = el('select', mode(app) === 'prod' ? 'prod' : ''); select.setAttribute('aria-label', `${app.name} 실행 환경`); select.dataset.focus = `${app.id}-mode`;
  for (const value of ['dev', 'prod']) { const option = el('option', '', value.toUpperCase()); option.value = value; select.append(option); } select.value = mode(app); select.addEventListener('change', () => { state.modes.set(app.id, select.value); render(); }); modeArea.append(select, el('span', 'port', (active(app) ? app.port : app.ports?.[mode(app)] || app.port) ? `:${active(app) ? app.port : app.ports?.[mode(app)] || app.port}` : '포트 자동 감지'));
  if (active(app) && app.mode && app.mode !== mode(app)) modeArea.append(el('span', '', `현재 ${app.mode.toUpperCase()} · 재시작 시 적용`));
  const actions = el('div', 'actions');
  const items = [['열기', () => attempt(() => api.openApp(app.id)), !active(app)], ['로그', () => showLogs(app), false], ['환경 설정', () => attempt(() => editEnv(app)), false], [active(app) ? '재시작' : '실행', () => action(app, active(app) ? 'restart' : 'start'), false], ['종료', () => action(app, 'stop'), !active(app)]];
  for (const [label, handler, disabled] of items) { const node = button(label, handler, label === '실행' ? 'primary' : ''); node.disabled = disabled || state.busy.has(app.id); node.dataset.focus = `${app.id}-${label}`; actions.append(node); }
  const remove = button('×', () => removeApp(app)); remove.setAttribute('aria-label', `${app.name} 등록 해제`); remove.title = '등록 해제'; remove.disabled = active(app) || state.busy.has(app.id); actions.append(remove);
  bottom.append(modeArea, actions); card.append(top, bottom); if (app.error) { const error = el('p', 'inline-error', app.error); error.setAttribute('role', 'status'); card.append(error); } return card;
}
async function action(app, command) { if (state.busy.has(app.id)) return; state.busy.add(app.id); render(); try { await api[command](app.id, mode(app)); } catch (error) { toast(`${app.name} · ${error.message}`, true); } finally { state.busy.delete(app.id); await refresh(true); } }
function modal(title, eyebrow = 'WORKSPACE SETTINGS') { state.logs = null; state.modalRevision = (state.modalRevision || 0) + 1; $('modal-title').textContent = title; $('modal-eyebrow').textContent = eyebrow; $('modal-body').replaceChildren(); $('modal-actions').replaceChildren(button('닫기', closeModal)); if (!$('modal').open) $('modal').showModal(); }
function closeModal() { $('modal').close(); state.logs = null; }
function field(label, value = '', placeholder = '') { const wrapper = el('label', 'field', label); const input = el('input'); input.value = value; input.placeholder = placeholder; wrapper.append(input); return { wrapper, input }; }
function submitButton(label, handler) { const node = button(label, async () => { node.disabled = true; try { await handler(); } catch (error) { toast(error.message || String(error), true); } finally { node.disabled = false; } }, 'primary'); $('modal-actions').append(node); return node; }
function addGroup() { modal('새 프로젝트 그룹'); const name = field('그룹 이름', '', '예. Powderroom'); $('modal-body').append(name.wrapper); const save = submitButton('그룹 만들기', async () => { if (!name.input.value.trim()) { name.input.focus(); return; } const result = await api.addGroup(name.input.value.trim()); state.group = result?.id || null; closeModal(); await refresh(true); }); name.input.addEventListener('keydown', (event) => { if (event.key === 'Enter') save.click(); }); name.input.focus(); }
function scriptField(label, selected, available) {
  const wrapper = el('label', 'field', label); const input = el('select');
  input.setAttribute('aria-label', label);
  for (const key of ['', ...available]) { const option = el('option', '', key || '스크립트 선택'); option.value = key; input.append(option); }
  input.value = selected; wrapper.append(input); return { wrapper, input };
}
async function addApp() { await attempt(async () => { const groupId = state.group; const config = await api.chooseProject(); if (!config) return; modal('프로젝트 연결', 'PROJECT SETUP'); const name = field('프로젝트 이름', config.name || ''); const path = el('p', 'help', config.path); const dev = scriptField('DEV 실행 스크립트', config.scripts?.dev || '', config.availableScripts); const prod = scriptField('PROD 실행 스크립트', config.scripts?.prod || '', config.availableScripts); const devEnv = field('DEV 환경 파일', config.envFiles?.dev || '', '.env.development'); const prodEnv = field('PROD 환경 파일', config.envFiles?.prod || '', '.env.production'); const commands = el('div', 'field-grid'); commands.append(dev.wrapper, prod.wrapper); const envs = el('div', 'field-grid'); envs.append(devEnv.wrapper, prodEnv.wrapper); $('modal-body').append(path, name.wrapper, commands, envs, el('p', 'help', 'package.json에서 실행할 스크립트를 선택하세요. 환경 파일은 프로젝트 기준 상대 경로를 입력하세요.')); submitButton('프로젝트 연결', async () => { if (!name.input.value.trim() || !dev.input.value.trim()) throw new Error('프로젝트 이름과 DEV 실행 명령을 입력해 주세요.'); await api.addApp(groupId, { ...config, name: name.input.value.trim(), scripts: { dev: dev.input.value.trim(), prod: prod.input.value.trim() }, envFiles: { dev: devEnv.input.value.trim(), prod: prodEnv.input.value.trim() } }); closeModal(); await refresh(true); }); }); }
function renameItem(item, isGroup) {
  modal(isGroup ? '그룹 이름 변경' : '프로젝트 이름 변경');
  const name = field(isGroup ? '그룹 이름' : '프로젝트 이름', item.name);
  const error = el('p', 'inline-error'); error.setAttribute('role', 'alert');
  $('modal-body').append(name.wrapper, error);
  const save = submitButton('이름 저장', async () => {
    if (!name.input.value.trim()) { error.textContent = '이름을 입력해 주세요.'; name.input.focus(); return; }
    await api[isGroup ? 'renameGroup' : 'renameApp'](item.id, name.input.value.trim());
    closeModal(); await refresh(true); toast('이름을 변경했어요.');
  });
  name.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save.click(); } });
  name.input.focus(); name.input.select();
}
function removeApp(app) { modal('프로젝트 등록 해제'); $('modal-body').append(el('p', 'help', `${app.name}을(를) 이 그룹에서 제거합니다. 프로젝트 폴더와 원본 환경 파일은 유지됩니다.`)); submitButton('등록 해제', async () => { await api.removeApp(app.id); closeModal(); await refresh(true); }); }
async function showLogs(app) { modal(`${app.name} 로그`, `${(app.mode || mode(app)).toUpperCase()} / PROCESS OUTPUT`); const output = el('pre', 'log-output', '로그 불러오는 중…'); output.id = 'log-output'; $('modal-body').append(output); state.logs = app.id; await attempt(async () => { const logs = await api.logs(app.id); if (state.logs === app.id) output.textContent = logs || '아직 출력된 로그가 없습니다.'; }); }
async function editEnv(app) {
  const selectedMode = mode(app); modal(`${app.name} 환경 설정`, `${selectedMode.toUpperCase()} / LOCAL OVERRIDES`); $('modal-body').append(el('p', 'help', '환경 설정 불러오는 중…'));
  const revision = state.modalRevision; const data = await api.env(app.id, selectedMode); if (!$('modal').open || state.modalRevision !== revision) return;
  $('modal-body').replaceChildren(); const overrides = Object.assign(Object.create(null), data.overrides); const bases = new Map(data.base.map(({ key, value }) => [key, value])); const keys = [...new Set([...bases.keys(), ...Object.keys(overrides)])];
  const scriptField = el('label', 'field', `${selectedMode.toUpperCase()} 실행 스크립트`);
  const scriptSelect = el('select'); scriptSelect.setAttribute('aria-label', `${selectedMode.toUpperCase()} 실행 스크립트`);
  for (const key of [...new Set([data.script, ...data.availableScripts])]) { const option = el('option', '', key || '스크립트 선택'); option.value = key; scriptSelect.append(option); }
  scriptSelect.value = data.script; scriptField.append(scriptSelect);
  $('modal-body').append(scriptField, el('p', 'help', 'package.json의 스크립트를 선택하세요. 저장한 명령은 다음 실행 또는 재시작부터 적용됩니다.'));
  $('modal-body').append(el('p', 'help', '기본 환경 파일 위에 개인 설정을 적용합니다. 체크를 끄면 기본값을 사용하고, 체크한 채 비워두면 빈 문자열을 적용합니다.'));
  const tools = el('div', 'env-tools'); const filter = el('input'); filter.type = 'search'; filter.placeholder = '환경변수 검색'; filter.setAttribute('aria-label', '환경변수 검색'); const revealLabel = el('label', 'check-label'); const reveal = el('input'); reveal.type = 'checkbox'; revealLabel.append(reveal, document.createTextNode('값 표시')); tools.append(filter, revealLabel); const rows = el('div'); $('modal-body').append(tools, rows);
  function drawRows() {
    rows.replaceChildren(); const matching = keys.filter((key) => key.toLowerCase().includes(filter.value.toLowerCase()));
    if (!matching.length) rows.append(el('p', 'help', keys.length ? '검색 결과가 없습니다.' : '환경변수가 없습니다. 아래에서 새 변수를 추가하세요.'));
    for (const key of matching) {
      const row = el('div', 'env-row'); row.append(el('strong', 'env-key', key), el('div', 'base-value', `기본값 · ${bases.has(key) ? (reveal.checked ? bases.get(key) || '(빈 값)' : '••••••••') : '(새 변수)'}`));
      const controls = el('div', 'override-controls'); const label = el('label', 'check-label'); const toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = Object.hasOwn(overrides, key); label.append(toggle, document.createTextNode('직접 설정')); const value = el('input'); value.type = reveal.checked ? 'text' : 'password'; value.autocomplete = 'off'; value.spellcheck = false; value.value = overrides[key] ?? ''; value.disabled = !toggle.checked; value.placeholder = toggle.checked ? '빈 값으로 적용' : '기본값 사용'; value.setAttribute('aria-label', `${key} 개인 설정`); toggle.addEventListener('change', () => { value.disabled = !toggle.checked; if (toggle.checked) { overrides[key] = value.value; value.focus(); } else delete overrides[key]; }); value.addEventListener('input', () => { overrides[key] = value.value; }); controls.append(label, value); row.append(controls);
      if (/API.*(URL|HOST)|BASE.*URL|API_URL/i.test(key)) row.append(button('로컬 주소 입력', () => { toggle.checked = true; value.disabled = false; value.value = 'http://localhost:8080'; value.type = 'text'; overrides[key] = value.value; value.focus(); value.select(); }, 'quick-api'));
      rows.append(row);
    }
  }
  filter.addEventListener('input', drawRows); reveal.addEventListener('change', drawRows); drawRows();
  const newKeyRow = el('div', 'new-key-row'); const newKey = el('input'); newKey.placeholder = '새 환경변수 이름'; newKey.setAttribute('aria-label', '새 환경변수 이름'); newKeyRow.append(newKey, button('＋ 변수 추가', () => { const key = newKey.value.trim(); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { toast('영문, 숫자, 밑줄로 변수 이름을 입력해 주세요.', true); return; } if (keys.includes(key)) { toast('이미 등록된 변수입니다.', true); return; } keys.push(key); overrides[key] = ''; newKey.value = ''; filter.value = ''; drawRows(); })); $('modal-body').append(newKeyRow);
  const save = async (restart) => { await api.saveEnv(app.id, selectedMode, overrides, scriptSelect.value || undefined); if (restart) await api.restart(app.id, selectedMode); closeModal(); toast(restart ? '환경을 저장하고 다시 시작했어요.' : '개인 환경 설정을 저장했어요.'); await refresh(true); };
  submitButton('설정 저장', () => save(false)); if (active(app)) submitButton(app.mode && app.mode !== selectedMode ? `저장 후 ${selectedMode.toUpperCase()}로 재시작` : '저장 후 재시작', () => save(true));
}
$('rename-group').addEventListener('click', () => { const group = currentGroup(); if (group) renameItem(group, true); });
$('add-group').addEventListener('click', addGroup); $('add-app').addEventListener('click', addApp); $('close-modal').addEventListener('click', closeModal); $('modal').addEventListener('close', () => { state.logs = null; });
$('group-mode').addEventListener('change', () => { const value = $('group-mode').value; if (value === 'mixed') return; for (const app of currentGroup()?.apps || []) state.modes.set(app.id, value); render(); toast(`${value.toUpperCase()} 환경을 선택했어요. 다음 실행 또는 재시작 시 적용됩니다.`); });
$('start-selected').addEventListener('click', () => { const apps = (currentGroup()?.apps || []).filter((app) => state.selected.get(app.id)); void Promise.all(apps.map((app) => action(app, active(app) && app.mode !== mode(app) ? 'restart' : 'start'))); });
$('stop-all').addEventListener('click', () => { void Promise.all((currentGroup()?.apps || []).filter(active).map((app) => action(app, 'stop'))); });
void attempt(() => refresh(true)); setInterval(() => { void attempt(() => refresh()); }, 1500);

$('auto-open').addEventListener('change', async () => {
  const checkbox = $('auto-open'); checkbox.disabled = true;
  try { await api.setAutoOpen(checkbox.checked); toast(checkbox.checked ? '실행 후 브라우저가 자동으로 열립니다.' : '브라우저 자동 열기를 껐어요.'); }
  catch (error) { checkbox.checked = !checkbox.checked; toast(error.message, true); }
  finally { checkbox.disabled = false; }
});
