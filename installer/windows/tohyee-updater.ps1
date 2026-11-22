# The Tohyee updater: installs an update a server admin asked for with
# Update now in Tohyee (UPD1-UPD6, src/lib/updates/remote-update.ts), so
# nobody has to sign in to the server computer.
#
# Run by Windows as SYSTEM, by the scheduled task "Tohyee updater" that
# configure-tohyee.ps1 sets up. The task looks for a request every minute and
# only starts this script when there is one.
#
# Tohyee itself runs as a limited account (NT SERVICE\Tohyee) that can't
# install anything. After backing everything up it writes
# %ProgramData%\Tohyee\update-request\request.json, the only folder there it
# can write. This script trusts nothing in that file but a version number
# (x.y.z), and installs it only if:
#   - it's newer than the installed version, and
#   - it's GitHub's latest release of Tohyee, and
#   - its TohyeeSetup-<version>.exe matches GitHub's SHA-256.
# It downloads into a folder only Administrators and SYSTEM can open, runs the
# installer silently, and says how it's going in
# %ProgramData%\Tohyee\update-status\status.json (Tohyee can read it, not
# change it). The installer stops Tohyee, replaces the program and starts it
# again, and Tohyee upgrades each organisation's database as it starts.
#
#   -CheckOnly   do every check but don't download or install (for tests)

param(
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repository = 'Willy-nz/Tohyee-ERP'
$ReleasesPrefix = "https://github.com/$Repository/releases/download/"
$UninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{8C7C1E2B-5F0A-4B8E-9C1D-6A1F3E7B2D40}_is1'

$DataRoot = Join-Path $env:ProgramData 'Tohyee'
$RequestFile = Join-Path $DataRoot 'update-request\request.json'
$StatusDir = Join-Path $DataRoot 'update-status'
$DownloadDir = Join-Path $DataRoot 'update-download'
$LogDir = Join-Path $DataRoot 'logs'

function Write-Status([string]$State, [string]$Version, [string]$Message) {
  New-Item -ItemType Directory -Force -Path $StatusDir | Out-Null
  $status = [ordered]@{
    state = $State
    version = $Version
    message = $Message
    at = (Get-Date).ToUniversalTime().ToString('o')
  }
  $file = Join-Path $StatusDir 'status.json'
  $partial = "$file.partial"
  [System.IO.File]::WriteAllText($partial, ($status | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
  Move-Item -LiteralPath $partial -Destination $file -Force
  Write-Host "$State $Version $Message"
}

if (-not (Test-Path -LiteralPath $RequestFile -PathType Leaf)) { exit 0 }

$wanted = $null
try {
  # The request came from a less trusted account: read a little of it, then remove it so it's handled once.
  $item = Get-Item -LiteralPath $RequestFile -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'The update request is a link, not a file, so it was ignored.' }
  if ($item.Length -gt 4096) { throw 'The update request is too big, so it was ignored.' }
  $text = [System.IO.File]::ReadAllText($RequestFile)
  if (-not $CheckOnly) { Remove-Item -LiteralPath $RequestFile -Force }
  $request = $text | ConvertFrom-Json
  $candidate = [string]$request.version
  if ($candidate -notmatch '^\d+\.\d+\.\d+$') { throw 'The update request doesn''t name a version (x.y.z), so it was ignored.' }
  $wanted = $candidate

  $installed = (Get-ItemProperty -LiteralPath $UninstallKey -ErrorAction SilentlyContinue).DisplayVersion
  if ($installed -and ([version]$wanted -le [version]$installed)) {
    Write-Status 'skipped' $wanted "v$installed is already installed."
    exit 0
  }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $headers = @{ 'User-Agent' = 'tohyee-updater'; 'Accept' = 'application/vnd.github+json' }
  $latest = Invoke-RestMethod -UseBasicParsing -Headers $headers -TimeoutSec 30 -Uri "https://api.github.com/repos/$Repository/releases/latest"
  if ([string]$latest.tag_name -ne "v$wanted") {
    Write-Status 'skipped' $wanted "The latest release is now $($latest.tag_name), not v$wanted. Ask for the update again."
    exit 0
  }

  $setupName = "TohyeeSetup-$wanted.exe"
  $asset = @($latest.assets | Where-Object { $_.name -eq $setupName }) | Select-Object -First 1
  if (-not $asset) { throw "Release v$wanted has no $setupName." }
  $url = [string]$asset.browser_download_url
  if (-not $url.StartsWith($ReleasesPrefix, [System.StringComparison]::Ordinal)) { throw "The installer isn't on Tohyee's GitHub releases page, so it wasn't downloaded." }

  # GitHub's own SHA-256 of the file, or the .sha256 file the release build uploads beside it.
  $sha256 = $null
  if ([string]$asset.digest -match '^sha256:([0-9a-fA-F]{64})$') { $sha256 = $Matches[1].ToLowerInvariant() }
  if (-not $sha256) {
    $hashAsset = @($latest.assets | Where-Object { $_.name -eq "$setupName.sha256" }) | Select-Object -First 1
    if ($hashAsset -and ([string]$hashAsset.browser_download_url).StartsWith($ReleasesPrefix, [System.StringComparison]::Ordinal)) {
      $hashText = (Invoke-WebRequest -UseBasicParsing -Headers $headers -TimeoutSec 30 -Uri $hashAsset.browser_download_url).Content
      if ($hashText -is [byte[]]) { $hashText = [System.Text.Encoding]::UTF8.GetString($hashText) }
      if ($hashText -match '([0-9a-fA-F]{64})') { $sha256 = $Matches[1].ToLowerInvariant() }
    }
  }
  if (-not $sha256) { throw "GitHub gave no SHA-256 for $setupName, so it wasn't downloaded." }

  if ($CheckOnly) {
    Write-Host "Would install v$wanted from $url (SHA-256 $sha256)."
    exit 0
  }

  Write-Status 'downloading' $wanted "Downloading $setupName."
  New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null
  Get-ChildItem -LiteralPath $DownloadDir -Force | Remove-Item -Force -Recurse
  $setup = Join-Path $DownloadDir $setupName
  $partial = "$setup.partial"
  Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = 'tohyee-updater' } -TimeoutSec 1800 -Uri $url -OutFile $partial
  $actual = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $sha256) {
    Remove-Item -LiteralPath $partial -Force
    throw "The downloaded installer doesn't match GitHub's SHA-256 (expected $sha256, got $actual), so it was deleted and not run. Nothing was changed."
  }
  Move-Item -LiteralPath $partial -Destination $setup -Force

  # Not waited for: the installer replaces this script and sets up this task again.
  $log = Join-Path $LogDir ("update-$wanted-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
  Write-Status 'installing' $wanted "Installing. The installer's log is $([System.IO.Path]::GetFileName($log)) in Tohyee's logs."
  Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$log`"")
  exit 0
} catch {
  $reason = $_.Exception.Message
  if ($CheckOnly) { Write-Host "Check failed: $reason"; exit 1 }
  try { Write-Status 'failed' $wanted $reason } catch { Write-Host "Couldn't write the status: $($_.Exception.Message)" }
  exit 1
}
