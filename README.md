# Dev Launcher

여러 프로젝트를 그룹으로 묶어 로컬 서버, 실행 스크립트, 환경변수를 관리하는 macOS 앱입니다. Electron과 일반 JavaScript로 구성했습니다.

## 설치와 사용

[최신 릴리스](https://github.com/vpvm96/Dev_Launcher/releases/latest)에서 Apple Silicon Mac용 DMG 또는 ZIP을 다운로드하고 `Dev Launcher.app`을 응용 프로그램 폴더로 옮깁니다.

1. 그룹 추가로 함께 사용할 프로젝트를 묶습니다.
2. 프로젝트 추가에서 내 컴퓨터의 프로젝트 폴더를 선택합니다.
3. DEV·PROD 실행 스크립트와 환경 파일을 지정합니다.
4. 선택 실행 또는 개별 실행·종료·재시작을 사용합니다.
5. 환경 설정에서 실행 스크립트와 개인 환경값을 수정합니다. 실행 중이면 저장 후 재시작할 수 있습니다.

프로젝트 코드와 환경 파일, 해당 프로젝트에 필요한 Node.js·패키지 매니저·설치된 의존성을 별도로 준비해야 합니다. DEV·PROD는 로컬 실행에 사용할 환경 설정이며, 운영 서버 배포 기능이 아닙니다.

`실행 후 브라우저 열기`는 모든 그룹에 적용되고 기본으로 켜져 있습니다. 서버 포트가 열리면 브라우저를 한 번 엽니다. 최대 2분 동안 기다린 뒤 로그에 안내합니다. Vite·CRA의 자체 자동 열기는 런처에서 제어합니다.

프로젝트 종료 시 로그가 초기화됩니다. 앱 창을 닫거나 앱 재시작을 누르면 런처에서 실행한 서버도 종료됩니다. 기존 터미널에서 실행한 서버는 관리하지 않습니다.

## 개인 설정

기본 환경 파일과 개인 설정을 합쳐 자식 프로세스에 전달합니다. 프로젝트의 `.env`와 원본 환경 파일을 수정하지 않습니다. 개인 설정은 `~/Library/Application Support/Dev Launcher`에 저장되며 배포 앱에 포함되지 않습니다. 기존 사용자 설정은 앱 업데이트 후에도 유지됩니다.

환경 파일 로더를 분리해 실제 서버 명령을 실행하므로 npm pre/post 스크립트는 실행하지 않습니다. 단순 npm/yarn/pnpm 별칭은 지원하며, 복합 패키지 명령은 지원하지 않습니다.

## 앱 업데이트

앱 실행 후와 6시간마다 GitHub Releases에서 새 버전을 확인합니다. 왼쪽 아래 업데이트 확인에서 수동 확인도 가능합니다. 다운로드 후 설치 후 재시작을 누르면 관리 중인 서버를 종료하고 업데이트를 설치합니다. 자동 다운로드나 종료 시 자동 설치는 하지 않습니다.

자동 업데이트 기능이 없던 1.0.0 사용자는 1.1.0 이상을 한 번 직접 설치해야 합니다. 이후에도 같은 앱 ID와 개발자 서명으로 배포합니다.

## 로컬 개발

```sh
npm ci
npm start
npm test
npm run test:ui
```

테스트는 별도의 임시 설정과 프로젝트를 사용합니다. 실제 등록된 서비스를 실행하지 않습니다.

## 배포 담당자

유효한 Developer ID Application 인증서와 개인 키가 Mac 키체인에 있어야 합니다. Apple 공증용 인증은 터미널에서 한 번 저장합니다. 앱 전용 암호는 대화형 입력으로 넣고 파일이나 Git에 저장하지 않습니다.

```sh
xcrun notarytool store-credentials dev-launcher
```

버전을 올리고 변경 사항을 커밋한 뒤 `main`에 푸시합니다. 다음 명령은 서명·공증된 DMG와 ZIP, 업데이트 메타데이터를 `release` 폴더에 생성합니다.

```sh
npm run package:release
npm run release:publish
```

`release:publish`는 현재 커밋이 `origin/main`과 일치하는지, 버전과 공증 상태를 확인한 다음 GitHub Releases 초안에 업로드하고 공개합니다. GitHub 인증은 배포 담당자의 `gh auth login` 설정을 사용합니다. 사용자 앱에 GitHub 토큰을 넣지 않습니다.

`npm run package`는 서명만 하는 로컬 검증용입니다. 공증하지 않으므로 공개 릴리스에 사용하지 않습니다.

참고 문서. [Electron 보안](https://www.electronjs.org/docs/latest/tutorial/security), [자동 업데이트](https://www.electron.build/v26/docs/features/auto-update/), [Apple 공증](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
