[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
$database = Join-Path (Split-Path $PSScriptRoot -Parent) '.runtime\memory.sqlite'
if (Test-Path -LiteralPath $database) {
  if ($PSCmdlet.ShouldProcess($database, 'Delete all durable memories')) {
    Remove-Item -LiteralPath $database -Force
    Write-Host 'Durable memory was reset.'
  }
} else { Write-Host 'No durable memory database exists.' }
