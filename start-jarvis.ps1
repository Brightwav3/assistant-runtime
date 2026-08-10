[CmdletBinding()]
param([string]$GeminiApiKey)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$state = Join-Path $root '.runtime'
New-Item -ItemType Directory -Force -Path $state | Out-Null

$assistantId = if ($env:ASSISTANT_ID) { $env:ASSISTANT_ID } else { 'assistant.primary' }
if ($GeminiApiKey) { $env:GEMINI_API_KEY = $GeminiApiKey }
if (-not $env:GEMINI_API_KEY) { throw 'GEMINI_API_KEY is required. Set it in this PowerShell session or pass -GeminiApiKey.' }
@{
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  assistantId = $assistantId
  note = 'Temporary launcher state only. No memories are stored here.'
} | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $state 'launcher.json')

Push-Location $root
try {
  npm run verify
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host 'Assistant runtime is starting. Press Ctrl+C to stop.'
  node dist/cli/main.js start
} finally { Pop-Location }
