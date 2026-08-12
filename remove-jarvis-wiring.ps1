[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$state = Join-Path $PSScriptRoot '.runtime'
$launcher = Join-Path $state 'launcher.json'
if (Test-Path -LiteralPath $launcher) {
  Remove-Item -LiteralPath $launcher -Force
  Write-Host 'Temporary launcher wiring removed. The Jarvis-root SQLite memory database was preserved.'
} else { Write-Host 'No temporary launcher wiring exists. The Jarvis-root SQLite memory database was preserved.' }
