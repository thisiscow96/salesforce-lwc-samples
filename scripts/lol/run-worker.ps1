# Claude Code를 헤드리스(-p)로 1회 실행해 대기 중인 LoL 분석 요청을 처리한다.
# Windows 작업 스케줄러에 등록하면 Claude Code 창을 열어 두지 않아도 주기적으로 처리됨 (PC는 켜져 있어야 함).
#   등록: powershell -ExecutionPolicy Bypass -File scripts\lol\run-worker.ps1 -Register [-EveryMinutes 5]
#   해제: Unregister-ScheduledTask -TaskName "LoL Claude Worker" -Confirm:$false
#   수동 1회: powershell -ExecutionPolicy Bypass -File scripts\lol\run-worker.ps1
# 권한은 워커 CLI 실행·웹 검색·결과 파일 쓰기로만 제한 (--allowedTools, 파일 쓰기 규칙은 Edit(path) 형식만 적용됨)
param([switch]$Register, [int]$EveryMinutes = 5)

$ErrorActionPreference = 'Stop'
$project = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

if ($Register) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`"" -WorkingDirectory $project
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -StartWhenAvailable
    Register-ScheduledTask -TaskName 'LoL Claude Worker' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "작업 스케줄러 등록: $EveryMinutes 분마다 실행 (작업 이름: LoL Claude Worker)"
    return
}

Set-Location $project
$env:Path = "$env:USERPROFILE\tools\node-v22.20.0-win-x64;$env:Path"
New-Item -ItemType Directory -Force (Join-Path $project '.lol-worker') | Out-Null
$log = Join-Path $project ".lol-worker\worker-$(Get-Date -Format yyyyMMdd).log"

# 대기 요청이 없으면 Claude를 호출하지 않음 (구독 사용량 절약)
$pending = node scripts/lol/claude-worker.js pending 1 | ConvertFrom-Json
if ($pending.count -eq 0) { return }

"=== $(Get-Date -Format s) 대기 요청 있음, Claude Code 실행 ===" | Add-Content -Encoding utf8 $log
# claude 출력은 UTF-8 → 콘솔 기본(CP949)으로 읽으면 로그 한글이 깨짐
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# 워커 명령은 Bash·PowerShell 어느 쪽으로 실행해도 허용 (그 외 명령은 헤드리스라 자동 거부됨)
claude -p "scripts/lol/WORKER.md 절차대로 LoL 분석 요청을 처리해줘. 워커 명령은 반드시 'node scripts/lol/claude-worker.js ...' 형태 그대로 실행해." `
    --allowedTools "Bash(node scripts/lol/claude-worker.js *)" "PowerShell(node scripts/lol/claude-worker.js *)" "Read" "Edit(.lol-worker/**)" "WebSearch" "WebFetch" 2>&1 |
    Add-Content -Encoding utf8 $log
