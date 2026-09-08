// 공증된 현재 버전 파일을 GitHub Releases 초안에 업로드하고 공개한다.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const { version } = require('../package.json');
const repo = 'vpvm96/Dev_Launcher';
const tag = `v${version}`;
const run = (cmd, args, quiet = false) => execFileSync(cmd, args, { cwd: root, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' });
try {
  if (run('git', ['status', '--porcelain'], true).trim()) throw new Error('변경 사항을 먼저 커밋해 주세요.');
  const head = run('git', ['rev-parse', 'HEAD'], true).trim();
  const remote = run('git', ['ls-remote', 'origin', 'refs/heads/main'], true).split(/\s/)[0];
  if (head !== remote) throw new Error('현재 커밋을 origin/main에 먼저 푸시해 주세요.');
  const directory = path.join(root, 'release');
  const files = [`Dev-Launcher-${version}-arm64.dmg`, `Dev-Launcher-${version}-arm64.zip`, 'latest-mac.yml'].map(file => path.join(directory, file));
  for (const file of files) if (!fs.existsSync(file)) throw new Error('npm run package:release를 먼저 실행해 주세요.');
  if (!fs.readFileSync(files[2], 'utf8').includes(`version: ${version}\n`)) throw new Error('업데이트 메타데이터 버전이 일치하지 않습니다.');
  run('xcrun', ['stapler', 'validate', path.join(directory, 'mac-arm64/Dev Launcher.app')]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose', path.join(directory, 'mac-arm64/Dev Launcher.app')]);
  run('gh', ['release', 'create', tag, '--repo', repo, '--target', head, '--draft', '--title', `Dev Launcher ${version}`, '--generate-notes']);
  for (const extension of ['dmg', 'zip']) {
    const blockmap = path.join(directory, `Dev-Launcher-${version}-arm64.${extension}.blockmap`);
    if (fs.existsSync(blockmap)) files.push(blockmap);
  }
  run('gh', ['release', 'upload', tag, '--repo', repo, ...files]);
  run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false']);
} catch (error) { console.error(error.message); process.exit(1); }
