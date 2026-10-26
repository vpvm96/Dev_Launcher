// 최신 N개 릴리스만 설치 파일(dmg/zip/blockmap)을 남기고 이전 릴리스의 큰 에셋을 삭제한다.
// 릴리스 페이지, 태그, latest-mac.yml은 그대로 유지한다. 기본은 미리보기이며 --apply를 붙여야 실제로 삭제한다.
const { execFileSync } = require('node:child_process');
const repo = 'vpvm96/Dev_Launcher';
const apply = process.argv.includes('--apply');
const keepArg = process.argv.find(arg => arg.startsWith('--keep='));
const keep = keepArg ? Number(keepArg.split('=')[1]) : 2;
const target = /\.(dmg|zip)(\.blockmap)?$/;
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep은 1 이상의 정수여야 합니다.');
  const releases = JSON.parse(gh(['release', 'list', '--repo', repo, '--limit', '100', '--json', 'tagName,isDraft,publishedAt']))
    .filter(release => !release.isDraft)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  let total = 0;
  for (const release of releases.slice(keep)) {
    const { assets } = JSON.parse(gh(['release', 'view', release.tagName, '--repo', repo, '--json', 'assets']));
    for (const asset of assets.filter(item => target.test(item.name))) {
      total += asset.size;
      console.log(`${apply ? '삭제' : '삭제 예정'}: ${release.tagName} ${asset.name} (${(asset.size / 1e6).toFixed(1)}MB)`);
      if (apply) gh(['release', 'delete-asset', release.tagName, asset.name, '--repo', repo, '--yes']);
    }
  }
  console.log(`${apply ? '확보' : '확보 예정'}: ${(total / 1e6).toFixed(0)}MB (최신 ${keep}개 릴리스 유지)`);
  if (!apply && total) console.log('실제로 삭제하려면 npm run release:prune -- --apply 를 실행하세요.');
} catch (error) { console.error(error.stderr?.toString().trim() || error.message); process.exit(1); }
