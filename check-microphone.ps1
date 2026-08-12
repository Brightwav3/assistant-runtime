<#
.SYNOPSIS
Proves a microphone actually delivers audio before a live assistant test.

.DESCRIPTION
Lists capture devices, records a short sample from one of them and reports the
peak amplitude against the activation threshold in config.json. Digital silence
is reported as a failure: a device that opens successfully but returns no signal
is the most common reason a live test appears to hang.

Windows exposes two different names for the same microphone. ffmpeg reports the
DirectShow name ("Mikrofon (Logitech G432 Gaming Headset)") and is used here for
recording. Activation Core reaches the device through WASAPI, which reports a
short name ("Mikrofon") and is what config.json accepts. Both lists are printed
so the two are never confused.

.EXAMPLE
./check-microphone.ps1 -List

.EXAMPLE
./check-microphone.ps1 -Device "Mikrofon (Logitech G432 Gaming Headset)"
#>
[CmdletBinding()]
param(
  [string]$Device,
  [int]$Seconds = 3,
  [switch]$List
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw 'ffmpeg is required. Install it with: winget install Gyan.FFmpeg'
}

function Get-CaptureDevices {
  $output = & ffmpeg -hide_banner -list_devices true -f dshow -i dummy 2>&1
  $output | Select-String -Pattern '"(.+)" \(audio\)' | ForEach-Object { $_.Matches[0].Groups[1].Value }
}

function Show-ActivationDevices {
  $script = 'import { Microphone } from "decibri"; for (const d of Microphone.devices()) console.log((d.isDefault ? "  * " : "    ") + "[" + d.index + "] " + d.name);'
  Push-Location (Join-Path (Split-Path $PSScriptRoot -Parent) 'activation-core')
  try { & node --input-type=module -e $script } catch { Write-Host '    (could not query Activation Core devices)' } finally { Pop-Location }
}

if ($List -or -not $Device) {
  $devices = Get-CaptureDevices
  if (-not $devices) { throw 'No DirectShow audio capture devices were found.' }
  Write-Host 'Recording devices (DirectShow names, used by this script):'
  $devices | ForEach-Object { Write-Host "    $_" }
  Write-Host ''
  Write-Host 'Activation devices (WASAPI names, what config.json accepts; * = system default):'
  Show-ActivationDevices
  Write-Host ''
  Write-Host 'These names differ for the same hardware. Leave activation.device unset to'
  Write-Host 'use the system default, which is the only unambiguous choice when several'
  Write-Host 'devices share a short name.'
  if ($List) { return }
  Write-Host ''
  Write-Host 'Re-run with -Device "<name>" to test one.'
  return
}

$configPath = Join-Path $PSScriptRoot 'config.json'
$threshold = 0.18
$rate = 16000
if (Test-Path -LiteralPath $configPath) {
  $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  if ($config.activation.amplitudeThreshold) { $threshold = [double]$config.activation.amplitudeThreshold }
  if ($config.realtime.inputSampleRate) { $rate = [int]$config.realtime.inputSampleRate }
}

$sample = Join-Path ([System.IO.Path]::GetTempPath()) 'assistant-mic-check.pcm'
Write-Host "Recording $Seconds s from `"$Device`" at $rate Hz. Speak and clap twice."
& ffmpeg -hide_banner -loglevel error -f dshow -i "audio=$Device" -t $Seconds -f s16le -ar $rate -ac 1 -y $sample
if ($LASTEXITCODE -ne 0) { throw "ffmpeg could not capture from `"$Device`"." }

$bytes = [System.IO.File]::ReadAllBytes($sample)
Remove-Item -LiteralPath $sample -Force -ErrorAction SilentlyContinue
if ($bytes.Length -lt 2) { throw 'The device produced no samples.' }

$peak = 0
for ($i = 0; $i -lt $bytes.Length - 1; $i += 2) {
  $value = [math]::Abs([BitConverter]::ToInt16($bytes, $i))
  if ($value -gt $peak) { $peak = $value }
}
$normalised = [math]::Round($peak / 32768, 4)

Write-Host ''
Write-Host "peak amplitude:        $normalised"
Write-Host "activation threshold:  $threshold"

if ($peak -le 1) {
  Write-Host ''
  Write-Host 'FAIL - the device opened but returned digital silence.' -ForegroundColor Red
  Write-Host 'Check the hardware mute switch, the Windows input level, and whether'
  Write-Host 'the device is a virtual one whose source application is not running.'
  exit 1
}
if ($normalised -lt $threshold) {
  Write-Host ''
  Write-Host 'WARN - audio arrives but never reached the activation threshold.' -ForegroundColor Yellow
  Write-Host 'Clap louder, raise the input level, or lower activation.amplitudeThreshold.'
  exit 2
}

Write-Host ''
Write-Host 'PASS - the device delivers audio loud enough to trigger activation.' -ForegroundColor Green
