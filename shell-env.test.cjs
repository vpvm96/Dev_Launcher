// 가짜 셸로 사용자 셸 환경을 읽는 동작을 검증한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readShellEnv } = require('./shell-env.cjs');

test('reads variables from an interactive shell while ignoring startup output', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-shell-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const shell = path.join(root, 'fake-shell');
  await fs.writeFile(shell, `#!/bin/sh\necho "welcome banner"\n[ "$1" = "-ilc" ] || exit 3\nexport JAVA_HOME="/opt/jdk 21" MULTI="a\nb" PATH="/custom/bin:$PATH"\nexec /bin/sh -c "$2"\n`, { mode: 0o755 });
  const env = readShellEnv({ shell });
  assert.equal(env.JAVA_HOME, '/opt/jdk 21');
  assert.equal(env.MULTI, 'a\nb');
  assert.match(env.PATH, /^\/custom\/bin:/);
  assert.equal(env.PWD, undefined);
});

test('fails when the shell output has no environment block', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-launcher-shell-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const shell = path.join(root, 'broken-shell');
  await fs.writeFile(shell, '#!/bin/sh\necho nothing\n', { mode: 0o755 });
  assert.throws(() => readShellEnv({ shell }), /셸 환경을 읽지 못했습니다/);
});
