# 배포 전후 검증 파이프라인: 하나라도 실패하면 즉시 중단
#  1) ESLint (LWC 공식 규칙)  2) Jest (실제 ECharts로 렌더링 검증, console.error 발생 시 실패)
#  3) org 배포  4) Apex 테스트 + 커버리지  5) headless Edge 스모크 테스트 (실제 화면, 콘솔 오류, 차트 수)
# 사용: powershell -ExecutionPolicy Bypass -File scripts\verify.ps1 [-SkipDeploy]
param([switch]$SkipDeploy)

$ErrorActionPreference = 'Stop'
$env:Path = "$env:USERPROFILE\tools\node-v22.20.0-win-x64;$env:Path"
$sf = 'C:\Program Files\sf\bin\sf.cmd'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Step($name, [scriptblock]$action) {
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
    & $action
    if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] $name" -ForegroundColor Red; exit 1 }
    Write-Host "[OK] $name" -ForegroundColor Green
}

Step 'ESLint' { npx eslint force-app/main/default/lwc }
Step 'Jest' { npx sfdx-lwc-jest }
if (-not $SkipDeploy) {
    Step 'Deploy' { & $sf project deploy start --source-dir force-app --target-org chartjs-dev }
    Step 'Apex Tests' { & $sf apex run test --class-names SalesDashboardControllerTest --class-names ExcelImportServiceTest --class-names LolTeamBuilderControllerTest --code-coverage --result-format human --wait 10 --target-org chartjs-dev }
}
Step 'Smoke Test (browser)' { node scripts/smoke-test.js }
Write-Host "`n모든 검증 통과" -ForegroundColor Green
