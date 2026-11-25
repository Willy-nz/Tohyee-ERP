# Sets up (or updates) Tohyee's database and Windows services. Run by
# TohyeeSetup.exe as Administrator after it copies the program files.
#
#   Program files: <InstallDir>  (node, pgsql, app, service, scripts, cloudflared)
#   Data:          %ProgramData%\Tohyee  (pgdata, service, logs, tohyee.env)
#
# Services (both start automatically when Windows starts, before anyone signs in):
#   TohyeePostgres  PostgreSQL, listening on localhost only
#   Tohyee          the Tohyee server (node), running as NT SERVICE\Tohyee (its own limited account), http://localhost:<port>, and its
#                   server settings address, http://127.0.0.1:<admin port>
#                   (this computer only; the tray app uses it)
#
# Safe to run again: existing passwords and data are kept.

param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  # Where to write what the installer's last page shows (optional).
  [string]$ResultFile = '',
  # The version being installed (for update-status\status.json).
  [string]$Version = '',
  # Tests only (installer/windows/test-install.ps1): fail on purpose at this
  # point, to prove an update that fails there is undone. 'before-start'.
  [string]$TestFailAt = ''
)

$ErrorActionPreference = 'Stop'
$DataRoot = Join-Path $env:ProgramData 'Tohyee'
$LogDir = Join-Path $DataRoot 'logs'
New-Item -ItemType Directory -Force -Path $DataRoot, $LogDir | Out-Null
Start-Transcript -Path (Join-Path $LogDir 'setup.log') -Append | Out-Null

# Update safety (update-guard.ps1, UPD10-UPD13): records how far setup got.
$Guard = Join-Path $PSScriptRoot 'update-guard.ps1'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
function Invoke-Guard([string[]]$Arguments) {
  # Its output goes to the log (Out-Host), so only the exit code is returned.
  & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $Guard @Arguments | Out-Host
  return $LASTEXITCODE
}
$startedNew = $false

try {
  $PgBin = Join-Path $InstallDir 'pgsql\bin'
  $PgData = Join-Path $DataRoot 'pgdata'
  $ServiceDir = Join-Path $DataRoot 'service'
  $EnvFile = Join-Path $DataRoot 'tohyee.env'
  $NodeExe = Join-Path $InstallDir 'node\node.exe'
  $AppDir = Join-Path $InstallDir 'app'
  $CloudflaredExe = Join-Path $InstallDir 'cloudflared\cloudflared.exe'

  function New-Secret([int]$Length) {
    $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    $bytes = New-Object byte[] $Length
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    return -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
  }

  function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$([System.IO.Path]::GetFileName($Exe)) $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
  }

  # Only Administrators and SYSTEM can read a file or folder (it holds passwords).
  # Inheritance flags only apply to folders; on a file they'd lock everyone out.
  function Protect-Path([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Container) {
      $grants = @('*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F')
    } else {
      $grants = @('*S-1-5-32-544:F', '*S-1-5-18:F')
    }
    Invoke-Checked 'icacls.exe' (@($Path, '/inheritance:r', '/grant:r') + $grants + @('/Q'))
  }

  # Issue #152: only Administrators and SYSTEM can open anything in the data
  # folder (the database files, analytics copies of the books, backups, logs).
  # ProgramData's own permissions let every local user read new folders, and
  # anyone can make a folder there, so: take ownership of everything (in case
  # someone else made the folder first), reset the folder's permissions, then
  # clear any permissions set further down so everything inherits from it.
  # The services are stopped first because PostgreSQL's files are included;
  # its own access is granted again further down.
  function Protect-DataRoot {
    foreach ($name in @('Tohyee', 'TohyeePostgres')) {
      if (Get-Service -Name $name -ErrorAction SilentlyContinue) { Stop-Service -Name $name -Force }
    }
    Invoke-Checked 'icacls.exe' @($DataRoot, '/setowner', '*S-1-5-32-544', '/T', '/C', '/Q')
    Invoke-Checked 'icacls.exe' @($DataRoot, '/reset', '/Q')
    Protect-Path $DataRoot
    foreach ($child in Get-ChildItem -LiteralPath $DataRoot -Force) {
      $resetArgs = @($child.FullName, '/reset')
      if ($child.PSIsContainer) { $resetArgs += '/T' }
      Invoke-Checked 'icacls.exe' ($resetArgs + @('/C', '/Q'))
    }
  }
  Protect-DataRoot

  # --- Settings and passwords -------------------------------------------------
  $settings = [ordered]@{}
  if (Test-Path $EnvFile) {
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $settings[$Matches[1]] = $Matches[2] }
    }
    Write-Host 'Keeping existing settings and passwords.'
  }
  $firstInstall = -not $settings.Contains('POSTGRES_PASSWORD')
  if ($firstInstall) {
    if (Test-Path (Join-Path $PgData 'PG_VERSION')) {
      throw "$PgData already has a database but $EnvFile has no password. Restore tohyee.env from a backup rather than reinstalling over it."
    }
    $settings['POSTGRES_PASSWORD'] = New-Secret 32
    $settings['SETUP_TOKEN'] = New-Secret 32
  }
  # The two everyday database logins; POSTGRES_PASSWORD's superuser is only used here.
  # Added on upgrade too.
  if (-not $settings.Contains('TOHYEE_DB_ADMIN_PASSWORD')) { $settings['TOHYEE_DB_ADMIN_PASSWORD'] = New-Secret 32 }
  if (-not $settings.Contains('TOHYEE_DB_APP_PASSWORD')) { $settings['TOHYEE_DB_APP_PASSWORD'] = New-Secret 32 }
  # Encrypts bank feed tokens. Added on upgrade too; changing it later makes saved tokens unreadable.
  if (-not $settings.Contains('TOHYEE_SECRET_KEY')) { $settings['TOHYEE_SECRET_KEY'] = New-Secret 48 }
  foreach ($default in @(@('TOHYEE_PORT', '3000'), @('TOHYEE_LISTEN', '127.0.0.1'), @('POSTGRES_PORT', '5433'))) {
    if (-not $settings.Contains($default[0])) { $settings[$default[0]] = $default[1] }
  }
  # Server settings: 127.0.0.1 only, used by the Tohyee server app (tray icon).
  if (-not $settings.Contains('TOHYEE_ADMIN_PORT')) { $settings['TOHYEE_ADMIN_PORT'] = [string]([int]$settings['TOHYEE_PORT'] + 1) }
  $lines = @('# Tohyee settings. Keep this file private and keep a copy with your backups:',
    '# it holds the database password, and a new one will not open your existing data.',
    '# After changing TOHYEE_PORT or TOHYEE_LISTEN, run the Tohyee setup again (Repair).')
  foreach ($key in $settings.Keys) { $lines += "$key=$($settings[$key])" }
  [System.IO.File]::WriteAllLines($EnvFile, [string[]]$lines)
  Protect-Path $EnvFile
  # Where the tray app finds Tohyee: ports only, nothing secret, readable by everyone.
  [System.IO.File]::WriteAllLines((Join-Path $DataRoot 'tray.ini'), [string[]]@(
    '# Written by the Tohyee installer for the tray app. Change the ports in tohyee.env instead.',
    "PORT=$($settings['TOHYEE_PORT'])",
    "ADMIN_PORT=$($settings['TOHYEE_ADMIN_PORT'])"))
  # The tray app runs as whoever is signed in, so everyone can read this one file.
  Invoke-Checked 'icacls.exe' @((Join-Path $DataRoot 'tray.ini'), '/grant', '*S-1-5-32-545:R', '/Q')

  $pgPort = $settings['POSTGRES_PORT']
  $env:PGPASSWORD = $settings['POSTGRES_PASSWORD']

  # --- PostgreSQL ----------------------------------------------------------------
  if (-not (Test-Path (Join-Path $PgData 'PG_VERSION'))) {
    Write-Host 'Creating the database cluster.'
    $pwFile = Join-Path $env:TEMP "tohyee-pw-$([guid]::NewGuid()).txt"
    [System.IO.File]::WriteAllText($pwFile, $settings['POSTGRES_PASSWORD'])
    # initdb drops administrator rights while it runs, so it can't write in
    # the data folder (Administrators and SYSTEM only). Give the account
    # running setup the empty pgdata folder just while initdb runs.
    New-Item -ItemType Directory -Force -Path $PgData | Out-Null
    $installingUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Invoke-Checked 'icacls.exe' @($PgData, '/grant', "*$($installingUser):(OI)(CI)F", '/Q')
    try {
      Invoke-Checked (Join-Path $PgBin 'initdb.exe') @('-D', $PgData, '-U', 'tohyee', "--pwfile=$pwFile", '-E', 'UTF8', '--locale=C', '-A', 'scram-sha-256')
    } finally {
      Remove-Item -Force $pwFile -ErrorAction SilentlyContinue
      Invoke-Checked 'icacls.exe' @($PgData, '/remove:g', "*$installingUser", '/T', '/C', '/Q')
    }
    Add-Content -Path (Join-Path $PgData 'postgresql.conf') -Encoding ascii -Value @(
      '', '# Tohyee', "listen_addresses = 'localhost'", "port = $pgPort")
  }
  # The database service runs as Network Service, which needs the data folder.
  Invoke-Checked 'icacls.exe' @($PgData, '/grant', '*S-1-5-20:(OI)(CI)F', '/T', '/Q')

  if (-not (Get-Service -Name 'TohyeePostgres' -ErrorAction SilentlyContinue)) {
    Write-Host 'Registering the TohyeePostgres service.'
    Invoke-Checked (Join-Path $PgBin 'pg_ctl.exe') @('register', '-N', 'TohyeePostgres', '-U', 'NT AUTHORITY\NetworkService', '-D', $PgData, '-S', 'auto', '-w')
  }
  Set-Service -Name 'TohyeePostgres' -StartupType Automatic
  # If PostgreSQL ever stops by itself, Windows starts it again (it recovers
  # from its own log as it starts); before, it stayed down until a restart.
  $pgFailure = Start-Process -FilePath 'sc.exe' -ArgumentList 'failure TohyeePostgres reset= 3600 actions= restart/10000/restart/30000/restart/60000' -Wait -PassThru -NoNewWindow
  if ($pgFailure.ExitCode -ne 0) { Write-Host "Couldn't set TohyeePostgres to restart if it stops (sc.exe exit code $($pgFailure.ExitCode))." }
  if ((Get-Service 'TohyeePostgres').Status -ne 'Running') { Start-Service 'TohyeePostgres' }

  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    & (Join-Path $PgBin 'pg_isready.exe') -h localhost -p $pgPort -U tohyee | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'PostgreSQL did not start. See the log in pgdata\log.' }

  $psql = Join-Path $PgBin 'psql.exe'
  $exists = & $psql -h localhost -p $pgPort -U tohyee -d postgres -tAc "select 1 from pg_database where datname = 'tohyee'"
  if ($LASTEXITCODE -ne 0) { throw 'Could not connect to PostgreSQL.' }

  # Issue #152: Tohyee runs with two ordinary logins rather than the superuser,
  # so a bug in the app can't reach the rest of the computer through
  # PostgreSQL (COPY ... TO PROGRAM, reading server files). tohyee_admin
  # (CREATEDB) owns the databases and runs migrations; tohyee_app only reads
  # and writes data. Names and passwords go in through PGOPTIONS, never on a
  # command line.
  $sqlDir = Join-Path $InstallDir 'scripts'
  $env:PGOPTIONS = "-c tohyee.admin_role=tohyee_admin -c tohyee.admin_password=$($settings['TOHYEE_DB_ADMIN_PASSWORD']) -c tohyee.app_role=tohyee_app -c tohyee.app_password=$($settings['TOHYEE_DB_APP_PASSWORD'])"
  try {
    Write-Host 'Setting up the database logins.'
    Invoke-Checked $psql @('-h', 'localhost', '-p', $pgPort, '-U', 'tohyee', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', (Join-Path $sqlDir 'database-logins.sql'))
  } finally {
    Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue
  }

  if ("$exists".Trim() -ne '1') {
    Write-Host 'Creating the tohyee database.'
    Invoke-Checked $psql @('-h', 'localhost', '-p', $pgPort, '-U', 'tohyee', '-d', 'postgres', '-c', 'create database tohyee owner tohyee_admin')
  }

  # Installs made before issue #152 had the superuser own every database and
  # table: hand them to tohyee_admin. Does nothing once that's done. Tohyee
  # grants tohyee_app its access itself when it starts.
  $databases = & $psql -h localhost -p $pgPort -U tohyee -d postgres -tAc "select datname from pg_database where datname = 'tohyee' or datname like 'tohyee\_org\_%' order by datname"
  if ($LASTEXITCODE -ne 0) { throw 'Could not list the Tohyee databases.' }
  $env:PGOPTIONS = '-c tohyee.admin_role=tohyee_admin'
  try {
    foreach ($database in @($databases | ForEach-Object { "$_".Trim() } | Where-Object { $_ })) {
      Write-Host "Checking who owns $database."
      Invoke-Checked $psql @('-h', 'localhost', '-p', $pgPort, '-U', 'tohyee', '-d', $database, '-v', 'ON_ERROR_STOP=1', '-q', '-f', (Join-Path $sqlDir 'database-owner.sql'))
    }
  } finally {
    Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue
  }

  # --- Tohyee service (WinSW) ------------------------------------------------------
  New-Item -ItemType Directory -Force -Path $ServiceDir | Out-Null
  Protect-Path $ServiceDir
  $serviceExe = Join-Path $ServiceDir 'TohyeeServer.exe'
  if (Test-Path $serviceExe) {
    if (Get-Service -Name 'Tohyee' -ErrorAction SilentlyContinue) {
      & $serviceExe stop | Out-Null
      & $serviceExe uninstall | Out-Null
      Start-Sleep -Seconds 2
    }
  }
  Copy-Item -Force (Join-Path $InstallDir 'service\WinSW-x64.exe') $serviceExe

  function X([string]$Value) { return [System.Security.SecurityElement]::Escape($Value) }
  # Optional: another Tohyee address service (Phone access > Tohyee address), set in tohyee.env.
  $addressServiceEnv = ''
  if ($settings.Contains('TOHYEE_ADDRESS_SERVICE_URL') -and $settings['TOHYEE_ADDRESS_SERVICE_URL']) {
    $addressServiceEnv = "  <env name=""TOHYEE_ADDRESS_SERVICE_URL"" value=""$(X $settings['TOHYEE_ADDRESS_SERVICE_URL'])""/>`r`n"
  }

  # The service's own temporary folder (its account's profile isn't relied on).
  $TempDir = Join-Path $DataRoot 'tmp'
  $databaseUrl = "postgresql://tohyee_app:$($settings['TOHYEE_DB_APP_PASSWORD'])@localhost:$pgPort/tohyee"
  $databaseAdminUrl = "postgresql://tohyee_admin:$($settings['TOHYEE_DB_ADMIN_PASSWORD'])@localhost:$pgPort/tohyee"
  $xml = @"
<service>
  <id>Tohyee</id>
  <name>Tohyee</name>
  <description>Tohyee accounting server (http://localhost:$(X $settings['TOHYEE_PORT']))</description>
  <executable>$(X $NodeExe)</executable>
  <arguments>server.js</arguments>
  <workingdirectory>$(X $AppDir)</workingdirectory>
  <startmode>Manual</startmode>
  <depend>TohyeePostgres</depend>
  <onfailure action="restart" delay="10 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>$(X $LogDir)</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
  <env name="NODE_ENV" value="production"/>
  <env name="NEXT_TELEMETRY_DISABLED" value="1"/>
  <env name="PORT" value="$(X $settings['TOHYEE_PORT'])"/>
  <env name="HOSTNAME" value="$(X $settings['TOHYEE_LISTEN'])"/>
  <env name="TOHYEE_ADMIN_PORT" value="$(X $settings['TOHYEE_ADMIN_PORT'])"/>
  <env name="DATABASE_URL" value="$(X $databaseUrl)"/>
  <env name="DATABASE_ADMIN_URL" value="$(X $databaseAdminUrl)"/>
  <env name="SETUP_TOKEN" value="$(X $settings['SETUP_TOKEN'])"/>
  <env name="TOHYEE_SECRET_KEY" value="$(X $settings['TOHYEE_SECRET_KEY'])"/>
  <env name="TOHYEE_TIME_ZONE" value="Pacific/Auckland"/>
  <env name="TOHYEE_CLOUDFLARED_PATH" value="$(X $CloudflaredExe)"/>
  <env name="TOHYEE_PG_BIN" value="$(X $PgBin)"/>
  <env name="TOHYEE_BACKUP_DIR" value="$(X (Join-Path $DataRoot 'backups'))"/>
  <env name="TOHYEE_LOG_DIR" value="$(X $LogDir)"/>
  <env name="TOHYEE_ANALYTICS_DIR" value="$(X (Join-Path $DataRoot 'analytics'))"/>
  <env name="TOHYEE_UPDATE_REQUEST_DIR" value="$(X (Join-Path $DataRoot 'update-request'))"/>
  <env name="TOHYEE_UPDATE_STATUS_DIR" value="$(X (Join-Path $DataRoot 'update-status'))"/>
  <env name="TEMP" value="$(X $TempDir)"/>
  <env name="TMP" value="$(X $TempDir)"/>
$addressServiceEnv</service>
"@
  [System.IO.File]::WriteAllText((Join-Path $ServiceDir 'TohyeeServer.xml'), $xml)

  Write-Host 'Installing and starting the Tohyee service.'
  # Installed as Manual, and only set to start by itself once the new version
  # is about to start (below): if the computer restarts before then, the old
  # version can still be put back (update-guard.ps1 Recover) without this one
  # having started and upgraded the databases first.
  Invoke-Checked $serviceExe @('install')

  # The service runs as its own virtual account,
  # NT SERVICE\Tohyee, not as SYSTEM, so a flaw in Tohyee or cloudflared
  # can't take over the computer. It gets only what it needs: to read the
  # program and its service settings, to write its logs, backups, analytics
  # data and temporary files, and each folder a server admin has chosen
  # (backups: write; analytics and bank files: read). A virtual account has
  # no password: sc.exe is given none (with password= "" it failed with
  # 1057 in CI),
  # and Windows' own service manager is the fallback.
  $account = 'NT SERVICE\Tohyee'
  $sc = Start-Process -FilePath 'sc.exe' -ArgumentList "config Tohyee obj= ""$account""" -Wait -PassThru -NoNewWindow
  if ($sc.ExitCode -ne 0) {
    Write-Host "sc.exe couldn't set the account (exit code $($sc.ExitCode)); trying Win32_Service.Change."
    $service = Get-CimInstance Win32_Service -Filter "Name='Tohyee'"
    $changed = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{ StartName = $account }
    if ($changed.ReturnValue -ne 0) { throw "Couldn't set the Tohyee service to run as $account (sc.exe exit code $($sc.ExitCode), Win32_Service.Change $($changed.ReturnValue))." }
  }
  Write-Host "The Tohyee service runs as $((Get-CimInstance Win32_Service -Filter "Name='Tohyee'").StartName)."
  Invoke-Checked 'icacls.exe' @($InstallDir, '/grant', "$($account):(OI)(CI)RX", '/T', '/C', '/Q')
  Invoke-Checked 'icacls.exe' @($DataRoot, '/grant', "$($account):(RX)", '/Q')
  Invoke-Checked 'icacls.exe' @($ServiceDir, '/grant', "$($account):(OI)(CI)RX", '/T', '/Q')
  foreach ($dir in @($LogDir, (Join-Path $DataRoot 'backups'), (Join-Path $DataRoot 'analytics'), $TempDir, (Join-Path $DataRoot 'update-request'))) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Invoke-Checked 'icacls.exe' @($dir, '/grant', "$($account):(OI)(CI)M", '/T', '/Q')
  }
  # Update now in Tohyee (UPD1-UPD6): Tohyee leaves a request in update-request
  # (above) and reads how it's going from update-status, which only the
  # updater (SYSTEM) writes. update-download stays Administrators and SYSTEM only.
  $updateStatusDir = Join-Path $DataRoot 'update-status'
  New-Item -ItemType Directory -Force -Path $updateStatusDir, (Join-Path $DataRoot 'update-download') | Out-Null
  Invoke-Checked 'icacls.exe' @($updateStatusDir, '/grant', "$($account):(OI)(CI)RX", '/T', '/Q')
  # Folders already chosen in Tohyee (a OneDrive backup folder, say), from before this change.
  # Not on a first install: Tohyee hasn't started yet, so there are none (and no table to read).
  $env:PGPASSWORD = $settings['POSTGRES_PASSWORD']
  if ($firstInstall) { $chosen = @() } else { $chosen = & $psql -h localhost -p $pgPort -U tohyee -d tohyee -tA -F '|' -c @"
select 'M', value->>'folder' from server_settings where key = 'backups' and coalesce(value->>'folder', '') <> ''
union all
select 'RX', f.value from server_settings s, jsonb_each_text(coalesce(s.value->'folders', '{}'::jsonb)) f
 where s.key in ('analytics_folders', 'bank_file_folders') and f.value <> ''
"@
  if ($LASTEXITCODE -ne 0) { Write-Host 'Could not read the folders chosen in Tohyee; choose them again in the server app if backups or imports fail.'; $chosen = @() } }
  foreach ($line in @($chosen | ForEach-Object { "$_".Trim() } | Where-Object { $_ })) {
    $rights, $folder = $line.Split('|', 2)
    if (-not (Test-Path -LiteralPath $folder -PathType Container)) { Write-Host "Skipping $folder (not found)."; continue }
    & icacls.exe $folder /grant "$($account):(OI)(CI)$rights" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "Could not give the Tohyee service access to $folder; choose it again in the server app." }
    else { Write-Host "The Tohyee service can use $folder." }
  }

  # --- Tohyee updater (scheduled task, SYSTEM) -----------------------------------
  # Every minute it looks for a request from Update now in Tohyee; only when
  # there is one does it start tohyee-updater.ps1 (see that script for its checks).
  $updaterScript = Join-Path $InstallDir 'scripts\tohyee-updater.ps1'
  $requestFile = Join-Path $DataRoot 'update-request\request.json'
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $updaterAction = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\cmd.exe') `
    -Argument "/d /c if exist ""$requestFile"" ""$powershell"" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""$updaterScript"""
  $updaterTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $updaterBoot = New-ScheduledTaskTrigger -AtStartup
  $updaterPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $updaterSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 45) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
  Register-ScheduledTask -TaskName 'Tohyee updater' -TaskPath '\Tohyee\' -Action $updaterAction `
    -Trigger @($updaterTrigger, $updaterBoot) -Principal $updaterPrincipal -Settings $updaterSettings -Force `
    -Description 'Installs a Tohyee update a server admin asked for in Tohyee (Update now). Checks GitHub and the SHA-256 itself.' | Out-Null
  Write-Host 'The Tohyee updater is set up (scheduled task \Tohyee\Tohyee updater).'

  # --- Update recovery (scheduled task, SYSTEM, at start-up) ------------------------
  # If the computer restarts in the middle of an update, before the new
  # version has started, this puts the old version back and starts it
  # (update-guard.ps1 Recover). Its copy lives in the data folder, which only
  # Administrators and SYSTEM can change, because the program folder is the
  # one being replaced.
  $guardDir = Join-Path $DataRoot 'updater'
  New-Item -ItemType Directory -Force -Path $guardDir | Out-Null
  Copy-Item -Force $Guard (Join-Path $guardDir 'update-guard.ps1')
  $recoverAction = New-ScheduledTaskAction -Execute $powershell `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""$(Join-Path $guardDir 'update-guard.ps1')"" -Mode Recover"
  $recoverSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
  Register-ScheduledTask -TaskName 'Tohyee update recovery' -TaskPath '\Tohyee\' -Action $recoverAction `
    -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $updaterPrincipal -Settings $recoverSettings -Force `
    -Description 'Puts the previous Tohyee back if the computer restarted in the middle of an update.' | Out-Null

  if ($TestFailAt -eq 'before-start') { throw 'Failing on purpose before the new version starts (test).' }

  # The point of no return: from here the new version starts and may upgrade
  # the databases, which the old version then can't open. So from here a
  # failure is reported with what to do, and the old program isn't put back.
  if ((Invoke-Guard @('-Mode', 'Mark', '-Stage', 'started-new')) -ne 0) { throw "Couldn't record the update's progress (update-guard.ps1)." }
  $startedNew = $true
  Invoke-Checked 'sc.exe' @('config', 'Tohyee', 'start=', 'delayed-auto')
  Invoke-Checked $serviceExe @('start')

  # Up to 10 minutes: the first start after an update upgrades every
  # organisation's database, which can take a while with many of them.
  $url = "http://localhost:$($settings['TOHYEE_PORT'])"
  $ready = $false
  for ($i = 0; $i -lt 300; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { throw "Tohyee did not answer at $url within 10 minutes. It may still be upgrading the databases: its logs are in $LogDir." }
  Write-Host "Tohyee is running at $url"
  # Done: the old copy can go, and Update now says "installed".
  Invoke-Guard @('-Mode', 'Finish', '-InstallDir', $InstallDir, '-Version', $Version) | Out-Null

  # Tells the installer's last page what to show.
  $status = if ($firstInstall) { "first-install`r`n$($settings['SETUP_TOKEN'])`r`n$url" } else { "update`r`n`r`n$url" }
  if ($ResultFile) { [System.IO.File]::WriteAllText($ResultFile, $status) }
  exit 0
} catch {
  $reason = $_.Exception.Message
  Write-Host "SETUP FAILED: $reason"
  # Before the new version started, the installer puts the old one back
  # (update-guard.ps1 Restore, from Tohyee.iss). After, say what to do.
  if ($startedNew) { try { Invoke-Guard @('-Mode', 'Fail', '-Message', $reason) | Out-Null } catch { } }
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
