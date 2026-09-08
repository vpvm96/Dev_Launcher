// 키체인의 공증 인증을 확인하고 서명 및 공증된 배포 파일을 만든다.
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const profile = process.env.APPLE_KEYCHAIN_PROFILE || 'dev-launcher';
try {
  execFileSync('xcrun', ['notarytool', 'history', '--keychain-profile', profile], { stdio: ['ignore', 'pipe', 'pipe'] });
} catch {
  console.error(`Apple 공증 인증이 필요합니다. 터미널에서 xcrun notarytool store-credentials ${profile} 명령으로 먼저 저장해 주세요.`);
  process.exit(1);
}
const result = spawnSync(path.join(__dirname, '../node_modules/.bin/electron-builder'), ['--mac', '--arm64', '--publish', 'never'], { stdio: 'inherit', env: { ...process.env, APPLE_KEYCHAIN_PROFILE: profile } });
process.exit(result.status ?? 1);
