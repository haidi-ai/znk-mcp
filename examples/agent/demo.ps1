# 30-second demo for examples/agent/agent.cjs
# Usage:  $env:DEEPSEEK_API_KEY="sk-..."   (this shell only, never a file)
#         powershell -NoProfile -ExecutionPolicy Bypass -File examples\agent\demo.ps1 -Step D:\jobs\box.step
param(
  [string]$Step = '',
  [string]$Question = '',
  [string]$Node = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $Node = $cmd.Source }
  elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { $Node = 'C:\Program Files\nodejs\node.exe' }
  else { Write-Host 'node not found on PATH; pass -Node <node.exe>.' -ForegroundColor Yellow; exit 2 }
}
$node = $Node
$agent = Join-Path $PSScriptRoot 'agent.cjs'
$out = Join-Path $env:TEMP ('znk-agent-demo-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

if (-not $env:DEEPSEEK_API_KEY) {
  Write-Host 'DEEPSEEK_API_KEY is not set. Set it for this shell only, then rerun.' -ForegroundColor Yellow
  Write-Host '  $env:DEEPSEEK_API_KEY = "sk-..."'
  exit 2
}

Write-Host '=== [1/2] MCP tools (no model call) ===' -ForegroundColor Cyan
& $node $agent --list-tools
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $Question) {
  if ($Step) { $Question = "这件能不能打？STEP 文件在 $Step" }
  else { Write-Host 'Give -Step <path to STEP> or -Question "<one sentence>".' -ForegroundColor Yellow; exit 2 }
}

Write-Host ''
Write-Host "=== [2/2] question: $Question ===" -ForegroundColor Cyan
& $node $agent $Question --out $out
$code = $LASTEXITCODE
Write-Host ''
Write-Host "evidence: $out" -ForegroundColor DarkGray
exit $code
