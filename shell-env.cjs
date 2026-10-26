// Finder에서 실행해도 터미널과 같은 환경변수를 쓰도록 사용자 셸의 환경을 읽어 온다.
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const MARK = '__DEV_LAUNCHER_ENV__';
const SKIP = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
// .zshrc까지 읽도록 대화형 로그인 셸로 실행하고, 시작 문구가 섞여도 표식 사이의 출력만 사용한다.
function readShellEnv({ shell = os.userInfo().shell || '/bin/zsh', timeout = 5000 } = {}) {
  const output = execFileSync(shell, ['-ilc', `printf '%s' '${MARK}'; env -0; printf '%s' '${MARK}'`], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
  const body = output.split(MARK)[1];
  if (body === undefined) throw new Error('셸 환경을 읽지 못했습니다.');
  const env = {};
  for (const entry of body.split('\0')) {
    const index = entry.indexOf('=');
    if (index > 0 && !SKIP.has(entry.slice(0, index))) env[entry.slice(0, index)] = entry.slice(index + 1);
  }
  if (!env.PATH) throw new Error('셸 환경에 PATH가 없습니다.');
  return env;
}
module.exports = { readShellEnv };
