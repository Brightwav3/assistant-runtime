[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$state = Join-Path $PSScriptRoot '.runtime'
if (Test-Path -LiteralPath $state) {
  Remove-Item -LiteralPath $state -Recurse -Force
  Write-Host 'Temporary runtime wiring removed. Source repositories and memories were preserved.'
} else { Write-Host 'No temporary runtime wiring exists.' }
