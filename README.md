# Chart.js Combo Bar/Line 샘플 (LWC)

Chart.js 공식 샘플 [Combo bar/line](https://www.chartjs.org/docs/latest/samples/other-charts/combo-bar-line.html)을 LWC + Chart.js(Static Resource)로 구현한 샘플입니다.
애니메이션 설정 패널을 추가해 Chart.js의 Animation 기능을 화면에서 바로 확인할 수 있습니다.

## 구성

| 파일 | 설명 |
|---|---|
| `force-app/main/default/staticresources/chartjs.js` | Chart.js **v4.5.1** UMD 빌드 (MIT License, jsDelivr에서 받은 공식 배포본) |
| `force-app/main/default/lwc/comboBarLineChart/` | 차트 LWC (App / Home / Record Page, Tab에 배치 가능) |
| `deploy/chartjs-lwc-mdapi.zip` | CLI 없이 배포할 때 쓰는 Metadata API 형식 zip |

## 1. Salesforce Org 발급 (직접 진행)

1. https://developer.salesforce.com/signup 에서 **Developer Edition** 무료 가입
   - 이메일 인증이 필요하므로 본인이 직접 진행해야 합니다.
   - Username은 이메일 형식이지만 실제 이메일과 달라도 됩니다 (예: `gunmen.chartjs@sample.dev`). 전 세계에서 유일해야 합니다.
2. 인증 메일의 링크로 비밀번호 설정 후 로그인
3. **Lightning Web Security 확인**: Setup → Session Settings → `Use Lightning Web Security for Lightning web components and Aura components`가 체크되어 있어야 합니다.
   - Chart.js v3 이상은 구 Locker Service에서 정상 동작하지 않는 경우가 있어 LWS가 필요합니다. 신규 Developer Edition은 기본 활성화입니다.

## 2. 배포

### 방법 A. Salesforce CLI (권장)

```bash
# Salesforce CLI 설치: https://developer.salesforce.com/tools/salesforcecli (Windows 설치 파일)
sf org login web --alias chartjs-dev
sf project deploy start --source-dir force-app --target-org chartjs-dev
```

### 방법 B. CLI 없이 Workbench로 zip 배포

1. https://workbench.developerforce.com 접속 → Environment: Production, API Version 선택 → 로그인
2. Migration → Deploy → `deploy/chartjs-lwc-mdapi.zip` 선택
3. 옵션에서 **Single Package** 체크 → Next → Deploy
4. 결과 화면에서 `success: true` 확인

> Workbench는 Salesforce 공식 지원 도구가 아닌 커뮤니티 도구입니다. 접속이 안 되면 방법 A를 사용하세요.

## 3. 화면에서 보기

배포하면 App Page(`Chartjs_Sample`)와 Tab(**Chart.js Sample**)이 함께 생성되고, System Administrator 프로필에 Tab이 표시됩니다.

- 바로 열기: `sf org open --target-org chartjs-dev --path lightning/n/Chartjs_Sample`
- 또는 App Launcher에서 **Chart.js Sample** 검색

다른 페이지에 넣으려면 Lightning App Builder에서 **Combo Bar/Line Chart (Chart.js)** 컴포넌트를 끌어다 놓으면 됩니다.

## 4. 기능

### 샘플 사이트와 동일한 Actions
`Randomize` / `Add Dataset` / `Add Data` / `Remove Dataset` / `Remove Data`

### Animation (Chart.js 내장 기능)

| 화면 설정 | Chart.js 옵션 | 설명 |
|---|---|---|
| 애니메이션 On/Off | `animation: false` | 모든 애니메이션 끄기 |
| Easing | `animation.easing` | 움직임 곡선. 기본 `easeOutQuart` (Chart.js는 30종 제공, 샘플에는 7종 노출) |
| Duration | `animation.duration` | 재생 시간(ms). 기본 1000 |
| 순차 등장 | `animation.delay` (함수) | 데이터 포인트마다 지연을 줘서 순서대로 등장 |
| 선 반복 | `animations.tension` + `loop: true` | 선(Line)의 곡률을 무한 반복 |
| 다시 재생 | `chart.reset()` → `chart.update()` | 처음부터 애니메이션 재생 |

그 밖에 Chart.js는 속성별 애니메이션(`animations`), 모드별 전환(`transitions`: active / show / hide / reset / resize), 진행·완료 콜백(`onProgress`, `onComplete`)을 지원합니다.
참고: https://www.chartjs.org/docs/latest/configuration/animations.html

## 5. ECharts 비교 샘플 (무료, Apache License 2.0)

같은 Combo 차트를 **Apache ECharts v6.1.0**으로 구현한 비교용 컴포넌트입니다.

| 항목 | 내용 |
|---|---|
| Static Resource | `echarts` (`staticresources/echarts.js`, 약 1.1MB, Apache 2.0 라이선스 문구 포함) |
| LWC | `echartsComboChart` → Tab **ECharts Sample** (`lightning/n/ECharts_Sample`) |
| Chart.js 대비 추가 표현 | 그라데이션·둥근 막대, 부드러운 곡선 + 영역 그라데이션, 십자 툴팁, 툴바(이미지 저장·데이터 보기·선/막대 전환·초기화), 확대·축소(dataZoom) |
| 애니메이션 | `animation`, `animationDuration`, `animationEasing`(8종 노출), `animationDelay`(순차 등장), `animationDurationUpdate` |

### 전용 앱: Chart Samples
App Launcher → **Chart Samples** 를 열면 상단 내비게이션에 **Chart.js Sample** / **ECharts Sample** 탭이 분리되어 있습니다.
(`applications/Chart_Samples.app-meta.xml`, 바로 열기: `sf org open --target-org chartjs-dev --path lightning/app/c__Chart_Samples`)

ECharts는 컨테이너에 canvas를 직접 추가하므로 템플릿의 컨테이너에 `lwc:dom="manual"`을 지정했고, 창 크기 변경 시 `chart.resize()`를 호출합니다.

## 참고 사항

- 데이터는 샘플과 같이 **랜덤 값**입니다. 실제 데이터를 쓰려면 Apex(`@AuraEnabled(cacheable=true)`)나 Lightning Data Service로 조회한 값을 `chart.data`에 넣으면 됩니다.
- Chart.js는 `loadScript`로 불러오면 `window.Chart`로 노출됩니다.
- 컴포넌트가 화면에서 사라질 때 `chart.destroy()`로 인스턴스를 정리합니다.

## 6. Sales Dashboard (ECharts, 실제 Opportunity 데이터)

Chart Samples 앱의 첫 탭 **Sales Dashboard**. 실무에서 바로 쓸 수 있는 형태의 영업 대시보드입니다.

| 영역 | 차트 | 상호작용 |
|---|---|---|
| KPI 5개 | 수주 금액, 목표 달성률, Win Rate, 진행 중 파이프라인(가중), 평균 수주 금액 | - |
| 월별 실적 | 누적 막대(수주+파이프라인) + 월 목표선 + 달성률(보조축) | 막대 클릭 → 해당 월 목록 |
| 목표 달성 | 2겹 게이지 (수주 / 예상 착지 = 수주 + 가중 파이프라인) | - |
| 파이프라인 | 단계별 퍼널 (Setup 단계 순서 유지) | 단계 클릭 → 목록 |
| 유입 분석 | Lead Source → 수주/실주/진행 Sankey | 노드·흐름 클릭 → 목록 |
| 고객 구성 | 산업 → 거래처 Treemap | 클릭 시 확대 + 목록 |
| 딜 분포 | 마감일 × 금액 Scatter (점 크기 = 확률, 오늘 기준선) | 휠 확대, 점 클릭 → 레코드 이동 |
| 일별 수주 | 캘린더 히트맵 | 날짜 클릭 → 목록 |
| 상세 목록 | lightning-datatable (정렬, 필터 pill) | - |

- 구조: `c-echart`(재사용 래퍼: 로드·리사이즈·정리·클릭 이벤트) + `c-sales-dashboard` + `chartOptions.js`(순수 함수) + Apex `SalesDashboardController`
- 보안: `with sharing` + `WITH USER_MODE` (Sharing·CRUD·FLS 적용), tooltip의 사용자 데이터는 HTML 이스케이프
- 권한: 관리자 외 사용자는 Permission Set **Sales Dashboard User** + Opportunity/Account 조회 권한 필요
- 연간 목표: App Builder 속성 `연간 매출 목표 금액` (사용자 통화 기준)
- 데모 데이터: `sf apex run --file scripts/apex/seed-demo-data.apex` / 삭제: `delete-demo-data.apex` (이름이 `[DEMO]`로 시작하는 레코드만)

## 7. 검증 방식

배포 성공은 문법 검사일 뿐이라 런타임 오류를 잡지 못합니다. 아래 단계를 모두 통과해야 완료로 봅니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

| 단계 | 도구 | 잡는 문제 |
|---|---|---|
| 1. 정적 분석 | ESLint (`@salesforce/eslint-config-lwc`) | LWC 규칙 위반, 문법 오류 |
| 2. 컴포넌트 테스트 | Jest (`sfdx-lwc-jest`) + **실제 ECharts SSR 렌더링** | `render()` 예약어 충돌 같은 런타임 오류(console.error 발생 시 실패), option이 실제로 도형을 그리는지, 드릴다운·정렬·오류 처리 |
| 3. 배포 | `sf project deploy start` | 메타데이터 오류 |
| 4. Apex 테스트 | `sf apex run test` | 집계 정확성(200건 Bulk), 권한 없는 사용자 처리, 커버리지 |
| 5. 스모크 테스트 | headless Edge + puppeteer-core (`scripts/smoke-test.js`) | 실제 org 화면의 콘솔 오류, 차트 수·크기, 컴포넌트 에러 문구 (스크린샷: `.smoke/`) |

## 8. Account Excel 업로드 (SheetJS, 무료 Apache 2.0)

Sales Dashboard 상단 **Excel 업로드** 버튼 → 표준 LightningModal에서 .xlsx/.csv를 올려 **Account + Contact**를 생성합니다.

| 항목 | 내용 |
|---|---|
| 데이터 모델 | 행마다 Contact 1건(First Name, Last Name, Email), 같은 Account Name은 Account 1건으로 묶음. (org에 Person Account가 꺼져 있어 Business Account + Contact 구조) |
| 헤더 | `Account Name`(필수), `First Name`, `Last Name`(필수), `Email` — 대소문자·공백 무시, 한글(회사명/이름/성/이메일) 허용. 화면에서 양식 다운로드 가능 |
| 흐름 | 파일 선택 → 브라우저에서 파싱·검증·미리보기 → 200행씩 Apex 순차 호출(진행률) → 결과 + 실패 목록 CSV |
| 제한 | 첫 시트, 최대 5,000행·5MB. 그 이상은 Data Loader / Bulk API 권장 |
| 구성 | Static Resource `sheetjs`(v0.20.3 mini) · LWC `accountExcelImport`(App Builder 단독 배치 가능) · `accountImportModal` · Apex `AccountExcelImportController` |
| 보안 | `with sharing` + `AccessLevel.USER_MODE` DML, CRUD 사전 확인, 서버 재검증 |
| 권한 | Permission Set **Account Excel Import User** + Account/Contact Create 권한·FLS |
| 실패 처리 | 부분 성공(allOrNone=false). Contact 실패로 비게 된 신규 Account는 삭제. 권한·시스템 오류는 즉시 중단 |

스모크 테스트는 실제 org에서 `[SMOKE]` 데이터로 업로드 → 저장 건수 확인 → 삭제(`scripts/apex/delete-smoke-data.apex`)까지 수행합니다.

## 9. LoL 팀 조합 분석기 (탭: LoL 팀 조합)

라인별 챔피언·플레이어 실력을 선택하면 100점 만점 점수, 항목별 근거, 강점/약점, 교체 추천, 전체 조합 탐색표, Excel, Claude 실시간 분석을 제공합니다.

| 구성 | 내용 |
|---|---|
| 데이터 | Custom Metadata: `LoL_Champion`(라인별 챔피언·능력치), `LoL_Synergy`(쌍별 시너지), `LoL_Score_Weight`(배점), `LoL_Tier`(티어→숙련도), `LoL_AI_Setting`(모델·검색) — Setup에서 수정 즉시 반영 |
| 초기 데이터 원본 | `scripts/lol/lol-data.js` → `node scripts/lol/build-metadata.js`로 CMDT XML 재생성 (Patch 26.20 통계 출처 주석 포함) |
| 점수 로직 | `lwc/lolTeamBuilder/lolScoring.js` (메타 10, 후반 15, CC 15, 앞라인 구조 15, AD/AP 10, 이니시·보호 10, 시너지 15, 실력 적합도 10) |
| Claude 연동 | Apex `LolTeamBuilderController`(Continuation) + `LolClaudeAnalysisService`, Named Credential `Claude_API` → `https://api.anthropic.com/v1/messages`, 웹 검색 도구 포함 |
| 권한 | Permission Set **LoL Team Builder User** (Apex·탭·External Credential Principal) |

### Claude API Key 등록 (최초 1회, 직접 입력)
1. Setup → Named Credentials → **External Credentials** 탭 → **Claude API**
2. Principals의 **ClaudeKey** → Edit → Authentication Parameters → Add: Name `ApiKey`, Value = Anthropic Console에서 발급한 Key
3. 사용자에게 Permission Set **LoL Team Builder User** 부여

Key는 metadata·코드·로그에 저장되지 않습니다. 모델/검색 횟수는 Custom Metadata `LoL AI Setting > Default`에서 변경합니다 (웹 검색 1,000회당 $10 + 토큰 비용).

### Claude Code 모드 (기본, API Key 불필요 · Claude 구독 사용)

`LoL AI Setting > Default`의 **Mode = CLAUDE_CODE**(기본) / **API**로 전환합니다.

```
[Claude Code 분석 요청] → LoL_Analysis_Request__c (Pending, 서버가 프롬프트 조립)
      ↓ (로컬 PC)
Claude Code 워커: claude-worker.js pending → claim → 웹 검색·분석 → complete
      ↓
화면이 10초마다 상태 확인 → 결과·출처 표시 (화면을 닫아도 "내 최근 요청"에서 확인)
```

| 실행 방법 | 명령 | 특징 |
|---|---|---|
| 대화 중 자동 처리 | Claude Code에서 `/loop 3m scripts/lol/WORKER.md 절차대로 LoL 분석 요청 처리` | Claude Code 창이 열려 있는 동안 |
| 백그라운드 자동 처리 | 프로젝트 폴더에서 `powershell -ExecutionPolicy Bypass -File scripts\lol\run-worker.ps1 -Register -EveryMinutes 1` (다른 폴더에서 실행하면 전체 경로 필요) | Windows 작업 스케줄러 (기본 5분, 현재 1분으로 등록됨), 대기 요청이 있을 때만 Claude 실행. 해제: `Unregister-ScheduledTask -TaskName "LoL Claude Worker"` |
| 수동 1회 | Claude Code에 "LoL 분석 요청 처리해줘" 또는 `run-worker.ps1` | |

- 워커 CLI(`scripts/lol/claude-worker.js`)는 `sf api request rest`로 org에 접근 (토큰을 직접 다루지 않음)
- 요청 OWD Private: 요청자는 본인 요청만 조회·생성 (수정·삭제 불가), 결과 기록은 관리자 워커
- 30분 넘게 Processing에 멈춘 요청은 다음 실행에서 재처리
- 개인 자동화 용도. 여러 사용자가 상시로 쓰면 API 모드가 정석

### 클라우드 루틴 모드 (PC가 꺼져 있어도 처리)

```
[분석 요청 저장] ─(즉시)→ LolRoutineFire(Queueable) → Claude_Routine Named Credential → 루틴 /fire
                                                           (매시간 예약 실행도 함께: 누락분 처리)
클라우드 루틴(Claude Code) → node scripts/lol/claude-worker.js (LOL_QUEUE_URL 설정 시 큐 API 사용)
   → https://<site>/lolworker/services/apexrest/lol/queue  (LolWorkerApi, Site: LoL_Worker)
      인증: X-LoL-Worker-Key 헤더 = 클라우드 환경의 네트워크 시크릿 (Claude는 키를 볼 수 없음)
            Salesforce에는 키의 SHA-256만 저장 (Custom Setting LoL_Worker_Setting__c)
```

| 구성 | 위치 |
|---|---|
| 큐 API | `classes/LolWorkerApi.cls` (pending / claim(선점, 409) / complete / fail), Site `LoL_Worker`, 게스트 프로필은 이 클래스만 허용 |
| 즉시 실행 | `classes/LolRoutineFire.cls`, Named Credential `Claude_Routine` (토큰은 External Credential에 직접 입력), CMDT `LoL AI Setting.Routine_Fire_Path__c` |
| 키 교체 | 새 키 생성 → 해시를 `LoL_Worker_Setting__c.Key_Hash__c`에 저장 → 클라우드 네트워크 시크릿 값 교체 |

- 루틴 예약 실행의 최소 간격은 1시간 → 즉시성은 API 트리거(/fire)로 확보
- PC 작업 스케줄러 워커와 동시에 켜 두어도 선점(claim)으로 중복 처리되지 않음
