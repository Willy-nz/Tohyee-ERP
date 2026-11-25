# Keeps a Tohyee update safe to undo (UPD10-UPD13). Run by TohyeeSetup.exe as
# Administrator, by configure-tohyee.ps1, and at start-up by the scheduled
# task "Tohyee update recovery" (as SYSTEM).
#
#   -Mode Prepare   Before any file is copied (Inno's PrepareToInstall):
#                   1. stop Windows restarting the services by themselves,
#                   2. stop both services and wait until they really are stopped,
#                   3. move the old program aside into <InstallDir>\previous.
#                   If any of that fails, everything is put back as it was,
#                   both services are started again, status.json says
#                   "failed" (nothing was changed) and this exits 1: setup
#                   then stops before touching a file.
#   -Mode Mark      configure-tohyee.ps1 records how far it got (-Stage started-new
#                   just before the new version first starts: from then on its
#                   database upgrades may run, so the old program can't be put back).
#   -Mode Restore   The update didn't get as far as starting the new version:
#                   put the old program back, start it, and say so in status.json.
#                   Does nothing (exit 2) when there's nothing to put back.
#   -Mode Recover   At start-up: like Restore, but only when an update was cut
#                   off (the computer restarted mid-update) and no setup is running.
#   -Mode Fail      The new version was started but setup failed after that:
#                   say so in status.json with what to do (-Message), and keep
#                   the old copy for a person to look at.
#   -Mode Finish    The new version answered: remove the old copy and say "installed".
#
# Never force-stops PostgreSQL: it's only ever asked to stop as a service
# (a clean shutdown) and waited for. Your data (%ProgramData%\Tohyee) isn't
# touched by any of this; only the program folders are moved.

param(
  [Parameter(Mandatory = $true)][ValidateSet('Prepare', 'Mark', 'Restore', 'Recover', 'Fail', 'Finish')][string]$Mode,
  [string]$InstallDir = '',
  # The version being installed.
  [string]$Version = '',
  [string]$Stage = '',
  [string]$Message = '',
  # Prepare and Restore write their message for the installer here.
  [string]$ResultFile = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$DataRoot = Join-Path $env:ProgramData 'Tohyee'
$StateFile = Join-Path $DataRoot 'update-state.json'
$StatusDir = Join-Path $DataRoot 'update-status'
$LogDir = Join-Path $DataRoot 'logs'
$UninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{8C7C1E2B-5F0A-4B8E-9C1D-6A1F3E7B2D40}_is1'
# The program folders an update replaces. Your data is never in these.
$ProgramFolders = @('app', 'node', 'scripts', 'tray', 'pgsql', 'cloudflared')
$Services = @('Tohyee', 'TohyeePostgres')

New-Item -ItemType Directory -Force -Path $DataRoot, $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'update-guard.log'

function Write-Log([string]$Text) {
  $line = "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) [$Mode] $Text"
  Write-Host $line
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
}

# The same file and format the updater writes (src/lib/updates/updater-status.ts reads it).
function Write-Status([string]$State, [string]$ForVersion, [string]$Message) {
  try {
    New-Item -ItemType Directory -Force -Path $StatusDir | Out-Null
    $status = [ordered]@{ state = $State; version = $ForVersion; message = $Message; at = (Get-Date).ToUniversalTime().ToString('o') }
    $file = Join-Path $StatusDir 'status.json'
    $partial = "$file.partial"
    [System.IO.File]::WriteAllText($partial, ($status | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
    Move-Item -LiteralPath $partial -Destination $file -Force
    Write-Log "status: $State $ForVersion $Message"
  } catch {
    Write-Log "Couldn't write status.json: $($_.Exception.Message)"
  }
}

function Write-Result([string]$Text) {
  if ($ResultFile) { try { [System.IO.File]::WriteAllText($ResultFile, $Text) } catch { } }
}

function Read-State {
  if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
  try { return [System.IO.File]::ReadAllText($StateFile) | ConvertFrom-Json } catch { Write-Log "update-state.json is unreadable: $($_.Exception.Message)"; return $null }
}

function Save-State($State) {
  $partial = "$StateFile.partial"
  [System.IO.File]::WriteAllText($partial, ($State | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
  Move-Item -LiteralPath $partial -Destination $StateFile -Force
}

# sc.exe through Start-Process, so an empty argument ("") reaches it as one
# (PowerShell 5.1 drops empty arguments to native commands).
function Invoke-Sc([string]$Arguments) {
  $out = Join-Path $env:TEMP "tohyee-sc-$([guid]::NewGuid()).txt"
  try {
    $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\sc.exe') -ArgumentList $Arguments -Wait -PassThru -NoNewWindow -RedirectStandardOutput $out
    if ($p.ExitCode -ne 0 -and (Test-Path -LiteralPath $out)) { Write-Log "sc.exe $Arguments`: $((Get-Content -LiteralPath $out -Raw).Trim())" }
    return $p.ExitCode
  } finally {
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
  }
}

# A service's start type as sc.exe spells it, from the registry (Get-Service can't tell delayed from automatic).
function Get-StartType([string]$Name) {
  $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name"
  $values = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
  if (-not $values) { return $null }
  switch ([int]$values.Start) {
    2 { if ([int]$values.DelayedAutostart -eq 1) { return 'delayed-auto' } else { return 'auto' } }
    3 { return 'demand' }
    4 { return 'disabled' }
    default { return 'auto' }
  }
}

function Test-Service([string]$Name) { return [bool](Get-Service -Name $Name -ErrorAction SilentlyContinue) }

# Waits until a service is Stopped (or gone). True when it is.
function Wait-Stopped([string]$Name, [int]$Seconds) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $service -or $service.Status -eq 'Stopped') { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# Waits while a service is starting or stopping (as at start-up), so it can be asked to stop.
function Wait-Settled([string]$Name, [int]$Seconds) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $service -or $service.Status -in @('Running', 'Stopped', 'Paused')) { return }
    Start-Sleep -Seconds 1
  }
}

# Processes started from the program folder, except PostgreSQL's server (which is only ever stopped as a service).
function Get-ProgramProcesses([switch]$IncludePostgres) {
  if (-not $InstallDir) { return @() }
  $prefix = $InstallDir.TrimEnd('\') + '\'
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and
      ($IncludePostgres -or ($_.Name -notin @('postgres.exe', 'pg_ctl.exe')))
    })
}

function Stop-ProgramProcesses {
  foreach ($process in Get-ProgramProcesses) {
    Write-Log "Stopping $($process.Name) (pid $($process.ProcessId)), started from the program folder."
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

# Turns off everything that could start a service by itself while files are
# being replaced. This comes BEFORE stopping, on purpose: in CI (22 Nov 2026)
# the service wrapper crashed while stopping, Windows' "restart on failure"
# started Tohyee again 11 seconds later, which started PostgreSQL with it, and
# setup failed on PostgreSQL's locked files. With no failure actions and no
# automatic start, a crash while stopping just leaves the service stopped.
function Disable-AutoStart {
  foreach ($name in $Services) {
    if (-not (Test-Service $name)) { continue }
    $code = Invoke-Sc "failure $name reset= 0 actions= """""
    if ($code -ne 0) { throw "Couldn't turn off $name's restart-on-failure (sc.exe exit code $code)." }
  }
  # Disabled, not just manual: nothing (the tray, a dependency, a person) can start Tohyee mid-update.
  if (Test-Service 'Tohyee') {
    $code = Invoke-Sc 'config Tohyee start= disabled'
    if ($code -ne 0) { throw "Couldn't stop Tohyee starting by itself (sc.exe exit code $code)." }
  }
  if (Test-Service 'TohyeePostgres') {
    $code = Invoke-Sc 'config TohyeePostgres start= demand'
    if ($code -ne 0) { throw "Couldn't stop TohyeePostgres starting by itself (sc.exe exit code $code)." }
  }
}

# Puts the start types back as they were, and the usual restart-on-failure.
function Restore-AutoStart($State) {
  $types = @{ Tohyee = 'delayed-auto'; TohyeePostgres = 'auto' }
  if ($State -and $State.startTypes) {
    foreach ($name in $Services) { if ($State.startTypes.$name) { $types[$name] = [string]$State.startTypes.$name } }
  }
  foreach ($name in $Services) {
    if (-not (Test-Service $name)) { continue }
    $start = $types[$name]
    # Never leave a service disabled by this script.
    if ($start -eq 'disabled') { $start = 'auto' }
    if ((Invoke-Sc "config $name start= $start") -ne 0) { Write-Log "Couldn't set $name to start $start." }
    if ((Invoke-Sc "failure $name reset= 3600 actions= restart/10000/restart/30000/restart/60000") -ne 0) { Write-Log "Couldn't set $name's restart-on-failure." }
  }
}

# Stops Tohyee (killing what it leaves behind, never PostgreSQL), then
# PostgreSQL with a clean shutdown. Throws if either won't stop.
function Stop-Everything {
  foreach ($name in $Services) { Wait-Settled $name 60 }
  if (Test-Service 'Tohyee') {
    Stop-Service -Name 'Tohyee' -Force -ErrorAction SilentlyContinue
    if (-not (Wait-Stopped 'Tohyee' 30)) {
      # The wrapper is stuck stopping (it waits on node): stop node and anything else
      # Tohyee started (cloudflared, pg_dump), then the wrapper itself. Safe for the
      # data: Tohyee's writes are transactions, and a cut-off backup is only a .partial file.
      Write-Log 'Tohyee is taking too long to stop; stopping its processes.'
      Stop-ProgramProcesses
      $wrapper = (Get-CimInstance Win32_Service -Filter "Name='Tohyee'" -ErrorAction SilentlyContinue).ProcessId
      if ($wrapper) { Stop-Process -Id $wrapper -Force -ErrorAction SilentlyContinue }
      if (-not (Wait-Stopped 'Tohyee' 30)) { throw "The Tohyee service didn't stop." }
    }
  }
  # Anything Tohyee started that outlived it (cloudflared, a backup's pg_dump) keeps its files locked.
  Stop-ProgramProcesses
  if (Test-Service 'TohyeePostgres') {
    # A normal service stop: PostgreSQL rolls back open transactions and writes a checkpoint.
    Stop-Service -Name 'TohyeePostgres' -Force -ErrorAction SilentlyContinue
    if (-not (Wait-Stopped 'TohyeePostgres' 120)) { throw "PostgreSQL (TohyeePostgres) didn't stop within 2 minutes. It wasn't forced, to keep the database safe." }
  }
  Start-Sleep -Seconds 1
  $left = Get-ProgramProcesses -IncludePostgres
  if ($left.Count -gt 0) { throw "These are still running from $InstallDir`: $(($left | ForEach-Object { "$($_.Name) (pid $($_.ProcessId))" }) -join ', ')." }
}

function Start-Everything {
  foreach ($name in @('TohyeePostgres', 'Tohyee')) {
    if (Test-Service $name) {
      try { Start-Service -Name $name } catch { Write-Log "Couldn't start $name`: $($_.Exception.Message)"; throw }
    }
  }
}

function Wait-Healthy([int]$Seconds) {
  $port = '3000'
  $envFile = Join-Path $DataRoot 'tray.ini'
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in [System.IO.File]::ReadAllLines($envFile)) { if ($line -match '^PORT=(\d+)$') { $port = $Matches[1] } }
  }
  for ($i = 0; $i -lt $Seconds; $i += 2) {
    try {
      $response = Invoke-WebRequest -Uri "http://localhost:$port/api/health" -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

# Moving or removing a folder can fail for a moment while something (an
# antivirus scan of files just written, say) has a file in it open: try a few times.
function Invoke-WithRetry([scriptblock]$Action, [string]$What) {
  for ($attempt = 1; ; $attempt++) {
    try { & $Action; return } catch {
      if ($attempt -ge 5) { throw "Couldn't $What`: $($_.Exception.Message)" }
      Write-Log "Couldn't $What yet ($($_.Exception.Message)); trying again."
      Start-Sleep -Seconds 2
    }
  }
}

function Get-InstalledVersion { return (Get-ItemProperty -LiteralPath $UninstallKey -ErrorAction SilentlyContinue).DisplayVersion }

# Moves what's in previous\ back, after removing whatever the new version left of the same folder.
function Move-PreviousBack {
  $previous = Join-Path $InstallDir 'previous'
  foreach ($folder in $ProgramFolders) {
    $kept = Join-Path $previous $folder
    if (-not (Test-Path -LiteralPath $kept)) { continue }
    $target = Join-Path $InstallDir $folder
    if (Test-Path -LiteralPath $target) { Invoke-WithRetry { Remove-Item -LiteralPath $target -Recurse -Force } "remove the new $folder" }
    Invoke-WithRetry { Move-Item -LiteralPath $kept -Destination $target } "move the old $folder back"
    Write-Log "Put the old $folder back."
  }
  if ((Test-Path -LiteralPath $previous) -and -not (Get-ChildItem -LiteralPath $previous -Force)) { Remove-Item -LiteralPath $previous -Force }
}

function Invoke-Restore($State) {
  $from = [string]$State.fromVersion
  $to = [string]$State.version
  if (-not $InstallDir) { $script:InstallDir = [string]$State.installDir }
  Write-Log "Putting v$from back (the update to v$to stopped at stage '$($State.stage)')."
  try {
    Stop-Everything
    if ($State.stage -eq 'swapped') { Move-PreviousBack }
    # The installer may have written the new version into Windows' list of programs.
    if ($from) { Set-ItemProperty -LiteralPath $UninstallKey -Name DisplayVersion -Value $from -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    if (-not (Test-Service 'Tohyee')) {
      # The update stopped after removing the Tohyee service and before adding it
      # again: the old version's own setup script adds it back.
      $configure = Join-Path $InstallDir 'scripts\configure-tohyee.ps1'
      Write-Log 'The Tohyee service is missing; setting it up again with the old version''s script.'
      & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $configure -InstallDir $InstallDir | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "Setting up v$from again failed (see setup.log)." }
    } else {
      Restore-AutoStart $State
      Start-Everything
    }
    if (-not (Wait-Healthy 180)) { throw "v$from was put back but didn't answer within 3 minutes." }
    $message = "v$to couldn't be installed, so v$from was put back and is running. Nothing in your data was changed. Try the update again; if it fails again, restart the server computer first. The details are in update-guard.log in Tohyee's logs."
    Write-Status 'failed' $to $message
    Write-Result $message
    return 0
  } catch {
    $message = "v$to couldn't be installed, and putting v$from back failed too: $($_.Exception.Message) Your data is safe (it isn't touched by an update, and was backed up first). On the server computer, run TohyeeSetup-$to.exe again (Update now keeps it in $DataRoot\update-download), or send update-guard.log and setup.log from Tohyee's logs to whoever helps you."
    Write-Log $message
    Write-Status 'failed' $to $message
    Write-Result $message
    return 1
  }
}

try {
  switch ($Mode) {
    'Prepare' {
      if (-not $InstallDir) { throw 'No -InstallDir.' }
      $earlier = Read-State
      if ($earlier -and $earlier.stage -in @('stopping', 'swapped')) {
        # An earlier update was cut off before it could be put back: put it back first.
        Write-Log "An earlier update (to v$($earlier.version)) didn't finish; putting the old program back first."
        if ((Invoke-Restore $earlier) -ne 0) { throw 'The earlier, unfinished update could not be undone.' }
      }
      $previous = Join-Path $InstallDir 'previous'
      if (Test-Path -LiteralPath $previous) {
        # Left by an update that started its new version and then had trouble: that copy can't run against the upgraded database.
        Write-Log "Removing $previous from an earlier update."
        Remove-Item -LiteralPath $previous -Recurse -Force
      }
      $hasServices = (Test-Service 'Tohyee') -or (Test-Service 'TohyeePostgres')
      $hasProgram = @($ProgramFolders | Where-Object { Test-Path -LiteralPath (Join-Path $InstallDir $_) }).Count -gt 0
      if (-not $hasServices -and -not $hasProgram) {
        Write-Log 'First install: nothing to stop or keep.'
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        exit 0
      }
      $state = [ordered]@{
        version = $Version
        fromVersion = [string](Get-InstalledVersion)
        installDir = $InstallDir
        startedAt = (Get-Date).ToUniversalTime().ToString('o')
        stage = 'stopping'
        startTypes = [ordered]@{ Tohyee = (Get-StartType 'Tohyee'); TohyeePostgres = (Get-StartType 'TohyeePostgres') }
        wasRunning = [ordered]@{
          Tohyee = [bool]((Get-Service 'Tohyee' -ErrorAction SilentlyContinue).Status -eq 'Running')
          TohyeePostgres = [bool]((Get-Service 'TohyeePostgres' -ErrorAction SilentlyContinue).Status -eq 'Running')
        }
      }
      # Written first, so a restart of the computer from here on can be undone at start-up.
      Save-State $state
      Write-Log "Updating v$($state.fromVersion) to v$Version in $InstallDir."
      $moved = @()
      try {
        Disable-AutoStart
        Stop-Everything
        # Rename, not copy: on the same drive it's instant, and the old files stay whole.
        # Recorded as "swapped" before the first move, so a restore after any part of it puts back what was moved.
        $state.stage = 'swapped'
        Save-State $state
        New-Item -ItemType Directory -Force -Path $previous | Out-Null
        foreach ($folder in $ProgramFolders) {
          $source = Join-Path $InstallDir $folder
          if (-not (Test-Path -LiteralPath $source)) { continue }
          Invoke-WithRetry { Move-Item -LiteralPath $source -Destination (Join-Path $previous $folder) } "move $source aside"
          $moved += $folder
        }
        Write-Log "Kept the old program in $previous ($($moved -join ', ')). Ready to copy the new one."
        exit 0
      } catch {
        $reason = $_.Exception.Message
        Write-Log "Couldn't get ready: $reason"
        # Put back what was moved, the start types and restart-on-failure, and start what was running.
        try { Move-PreviousBack } catch { Write-Log "Moving the old program back: $($_.Exception.Message)" }
        Restore-AutoStart $state
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        foreach ($name in @('TohyeePostgres', 'Tohyee')) {
          if ($state.wasRunning[$name]) { try { Start-Service -Name $name } catch { Write-Log "Couldn't start $name again: $($_.Exception.Message)" } }
        }
        $message = "Tohyee couldn't be stopped for the update to v$Version, so nothing was changed and v$($state.fromVersion) is still running. ($reason) Try again; if it happens again, restart the server computer first."
        Write-Status 'failed' $Version $message
        Write-Result $message
        exit 1
      }
    }
    'Mark' {
      $state = Read-State
      if (-not $state) { exit 0 }
      $state.stage = $Stage
      Save-State $state
      Write-Log "Stage: $Stage"
      exit 0
    }
    'Restore' {
      $state = Read-State
      if (-not $state -or $state.stage -notin @('stopping', 'swapped')) {
        Write-Log "Nothing to put back (stage: $(if ($state) { $state.stage } else { 'none' }))."
        exit 2
      }
      exit (Invoke-Restore $state)
    }
    'Recover' {
      $state = Read-State
      if (-not $state -or $state.stage -notin @('stopping', 'swapped')) { exit 0 }
      $setup = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'TohyeeSetup*' })
      if ($setup.Count -gt 0) { Write-Log 'Setup is running; leaving the update to it.'; exit 0 }
      Write-Log 'The computer started in the middle of an update.'
      exit (Invoke-Restore $state)
    }
    'Fail' {
      $state = Read-State
      if (-not $state) { exit 0 }
      $state.stage = 'failed-after-start'
      Save-State $state
      $to = [string]$state.version
      $text = "v$to was started but setup didn't finish: $Message " +
        "Don't put the old version back by hand: v$to may already have upgraded the databases. Your backups from before the update are in Tohyee's backups folder. " +
        "On the server computer, run TohyeeSetup-$to.exe again (Update now keeps it in $DataRoot\update-download), or send setup.log from Tohyee's logs to whoever helps you."
      Write-Status 'failed' $to $text
      Write-Result $text
      exit 0
    }
    'Finish' {
      $state = Read-State
      $folder = if ($InstallDir) { Join-Path $InstallDir 'previous' } elseif ($state) { Join-Path ([string]$state.installDir) 'previous' } else { $null }
      if ($folder -and (Test-Path -LiteralPath $folder)) { Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue }
      Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
      if ($state -and $Version) { Write-Status 'installed' $Version "v$Version is installed and running." }
      exit 0
    }
  }
} catch {
  Write-Log "Failed: $($_.Exception.Message)"
  Write-Result $_.Exception.Message
  exit 1
}
