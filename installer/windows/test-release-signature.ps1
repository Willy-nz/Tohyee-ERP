# Checks the installer signature rules (UPD14-UPD19) with throwaway keys made
# here and thrown away at the end: release-signature.ps1 (used by the updater
# and the release build) and, when -TrayExe is given, the server app's own
# check (TohyeeTray.exe --verify-release). No install needed. Run by the
# Windows installer workflow with Windows PowerShell 5.1 (as on a server) and
# PowerShell 7, and by test-install.ps1 against the installed copies
# (-Library, -ShippedKeys, -TrayExe).
#
#   powershell -NoProfile -File installer/windows/test-release-signature.ps1 [-TrayExe path]

param(
  [string]$TrayExe,
  [string]$Library = (Join-Path $PSScriptRoot 'release-signature.ps1'),
  [string]$ShippedKeys = (Join-Path $PSScriptRoot 'release-keys.txt')
)

$ErrorActionPreference = 'Stop'
. $Library

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("tohyee-sig-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$failures = 0

function New-ThrowawayKey {
  $rsa = New-TohyeeRsa
  $rsa.KeySize = 3072
  # Some RSA classes make the key only when it's first used.
  $null = $rsa.ExportParameters($false)
  return [pscustomobject]@{ Private = $rsa.ToXmlString($true); Public = $rsa.ToXmlString($false); Id = (Get-TohyeeKeyId $rsa) }
}

function Write-Keys([string]$Name, [string[]]$Lines) {
  $path = Join-Path $work $Name
  [System.IO.File]::WriteAllLines($path, [string[]](@('# throwaway keys for this test') + $Lines))
  return $path
}

function New-Installer([string]$Name) {
  $path = Join-Path $work $Name
  $bytes = New-Object byte[] 200000
  (New-Object System.Random 7).NextBytes($bytes)
  [System.IO.File]::WriteAllBytes($path, $bytes)
  return $path
}

function Save-Signature([string]$Path, [string]$FileName, $Key) {
  $sig = "$Path.sig"
  [System.IO.File]::WriteAllText($sig, (New-TohyeeReleaseSignature -Path $Path -FileName $FileName -PrivateKeyXml $Key.Private), (New-Object System.Text.UTF8Encoding $false))
  return $sig
}

# One case, checked by the script and (if given) the tray app.
function Check([string]$Label, [string]$Path, [string]$FileName, [string]$Sig, [string]$Keys, [string]$Expect, [string]$Says = '') {
  $got = $null
  $message = ''
  try {
    $result = Test-TohyeeReleaseSignature -Path $Path -FileName $FileName -SignaturePath $Sig -KeysPath $Keys
    $got = if ($result.Signed) { 'signed' } else { 'unsigned' }
    $message = "$($result.KeyId)"
  } catch {
    $got = 'refused'
    $message = $_.Exception.Message
  }
  $ok = ($got -eq $Expect) -and (-not $Says -or $message -like "*$Says*")
  Write-Host ("{0} script: {1}: {2} ({3})" -f $(if ($ok) { 'ok  ' } else { 'FAIL' }), $Label, $got, $message)
  if (-not $ok) { $script:failures++ }

  if ($TrayExe) {
    $out = Join-Path $work 'tray-result.txt'
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    $arguments = @('--verify-release', "`"$Path`"", "`"$FileName`"", "`"$Sig`"", "`"$Keys`"", "`"$out`"")
    $p = Start-Process -FilePath $TrayExe -ArgumentList $arguments -Wait -PassThru
    $text = if (Test-Path -LiteralPath $out) { ([System.IO.File]::ReadAllText($out)).Trim() } else { '(no answer)' }
    $trayGot = switch ($p.ExitCode) { 0 { 'signed' } 3 { 'unsigned' } 2 { 'refused' } default { "exit $($p.ExitCode)" } }
    $trayOk = ($trayGot -eq $Expect) -and (-not $Says -or $text -like "*$Says*")
    Write-Host ("{0} tray:   {1}: {2} ({3})" -f $(if ($trayOk) { 'ok  ' } else { 'FAIL' }), $Label, $trayGot, $text)
    if (-not $trayOk) { $script:failures++ }
  }
}

try {
  Write-Host "PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)), CLR $([Environment]::Version); checking $Library"
  $a = New-ThrowawayKey
  $b = New-ThrowawayKey
  $stranger = New-ThrowawayKey
  $name = 'TohyeeSetup-9.8.7.exe'
  $setup = New-Installer $name
  $onlyA = Write-Keys 'only-a.txt' @($a.Public)
  $aAndB = Write-Keys 'a-and-b.txt' @($a.Public, $b.Public)
  $none = Write-Keys 'none.txt' @()

  # UPD14: signed by a trusted key.
  $sigA = Save-Signature $setup $name $a
  Check 'signed by the trusted key' $setup $name $sigA $onlyA 'signed'
  # UPD18: a new key alongside the old one; either is accepted.
  Check 'old key, while both are trusted' $setup $name $sigA $aAndB 'signed'
  $sigB = Save-Signature (Copy-Item -LiteralPath $setup -Destination (Join-Path $work 'b') -PassThru).FullName $name $b
  Check 'new key, while both are trusted' (Join-Path $work 'b') $name $sigB $aAndB 'signed'
  Check 'new key, not trusted yet' (Join-Path $work 'b') $name $sigB $onlyA 'refused' 'trusts'

  # UPD15: a file changed after signing.
  $tampered = Join-Path $work 'tampered.exe'
  Copy-Item -LiteralPath $setup -Destination $tampered
  $stream = [System.IO.File]::Open($tampered, 'Append')
  $stream.WriteByte(0); $stream.Dispose()
  Check 'changed after signing' $tampered $name $sigA $onlyA 'refused' 'match its signature'
  # ...with the SHA-256 in the .sig changed to match: the signature itself fails.
  $forged = Join-Path $work 'forged.sig'
  $hash = Get-TohyeeSha256Hex $tampered
  [System.IO.File]::WriteAllText($forged, ([System.IO.File]::ReadAllText($sigA) -replace '(?m)^sha256: .*$', "sha256: $hash"))
  Check 'changed, and its SHA-256 line too' $tampered $name $forged $onlyA 'refused' 'trusts'
  # Signed by a key nobody trusts.
  $sigStranger = Save-Signature (Copy-Item -LiteralPath $setup -Destination (Join-Path $work 'c') -PassThru).FullName $name $stranger
  Check 'signed by an unknown key' (Join-Path $work 'c') $name $sigStranger $onlyA 'refused' 'trusts'
  # An older signed installer under a newer name.
  Check 'signature for another version' $setup 'TohyeeSetup-9.8.8.exe' $sigA $onlyA 'refused' 'not TohyeeSetup-9.8.8.exe'

  # UPD16: no signature while keys are trusted.
  Check 'no .sig' $setup $name (Join-Path $work 'missing.sig') $onlyA 'refused' "isn't signed"
  $junk = Join-Path $work 'junk.sig'
  [System.IO.File]::WriteAllText($junk, 'hello')
  Check 'not a signature file' $setup $name $junk $onlyA 'refused' "isn't one Tohyee can read"

  # UPD17: an install with no keys keeps the SHA-256 check only.
  Check 'no keys in the file' $setup $name (Join-Path $work 'missing.sig') $none 'unsigned'
  Check 'no keys file at all' $setup $name $sigA (Join-Path $work 'no-such-file.txt') 'unsigned'

  # A private key put in the keys file by mistake is refused, not used.
  $leaked = Write-Keys 'leaked.txt' @($a.Private)
  Check 'a private key in the keys file' $setup $name $sigA $leaked 'refused' 'private key'

  # The keys file the installer ships must read cleanly.
  $shipped = Get-TohyeeReleaseKeys $ShippedKeys
  Write-Host "$ShippedKeys lists $($shipped.Count) key(s): $(($shipped | ForEach-Object { $_.Id }) -join ', ')"

  # The release build's signing script: with and without the secret.
  $previous = $env:TOHYEE_RELEASE_SIGNING_KEY
  $previousOutput = $env:GITHUB_OUTPUT
  try {
    $env:GITHUB_OUTPUT = Join-Path $work 'output.txt'
    $release = New-Installer 'TohyeeSetup-9.8.9.exe'
    Remove-Item Env:TOHYEE_RELEASE_SIGNING_KEY -ErrorAction SilentlyContinue
    & (Join-Path $PSScriptRoot 'sign-installer.ps1') -Setup $release -KeysFile $onlyA
    if (Test-Path -LiteralPath "$release.sig") { Write-Host 'FAIL sign-installer: signed with no key'; $failures++ } else { Write-Host 'ok   sign-installer: no key, no .sig' }
    $env:TOHYEE_RELEASE_SIGNING_KEY = $a.Private
    & (Join-Path $PSScriptRoot 'sign-installer.ps1') -Setup $release -KeysFile $onlyA
    Check 'sign-installer.ps1 output' $release 'TohyeeSetup-9.8.9.exe' "$release.sig" $onlyA 'signed'
    $env:TOHYEE_RELEASE_SIGNING_KEY = $stranger.Private
    $refusedWrongKey = $false
    try { & (Join-Path $PSScriptRoot 'sign-installer.ps1') -Setup $release -KeysFile $onlyA } catch { $refusedWrongKey = $_.Exception.Message -like '*isn''t one of the keys*' }
    if ($refusedWrongKey -and -not (Test-Path -LiteralPath "$release.sig")) { Write-Host 'ok   sign-installer: a key release-keys.txt does not list is refused' } else { Write-Host 'FAIL sign-installer: signed with a key nobody trusts'; $failures++ }
    $outputs = [System.IO.File]::ReadAllLines($env:GITHUB_OUTPUT)
    if (($outputs -join ',') -ne 'signed=false,signed=true') { Write-Host "FAIL sign-installer outputs: $($outputs -join ',')"; $failures++ }
  } finally {
    $env:TOHYEE_RELEASE_SIGNING_KEY = $previous
    $env:GITHUB_OUTPUT = $previousOutput
  }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures -gt 0) { throw "$failures signature check(s) failed." }
Write-Host 'All signature checks passed.'
