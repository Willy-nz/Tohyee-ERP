# Signs TohyeeSetup-<version>.exe for a release (UPD14-UPD19), writing
# TohyeeSetup-<version>.exe.sig beside it. Run by the release workflow's
# sign job, which has the private key and runs nothing else of the repo's
# (no npm). The key comes from the environment, never from a file in the repo:
#
#   $env:TOHYEE_RELEASE_SIGNING_KEY = '<RSAKeyValue>…</RSAKeyValue>'   (the private key)
#   ./installer/windows/sign-installer.ps1 -Setup dist\windows\TohyeeSetup-1.2.3.exe
#
# With no key it signs nothing and says the release isn't signed (so a fork,
# or this repo before the key is set up, still builds). After signing it
# checks the signature against release-keys.txt: if that lists keys and none
# of them made this signature, it stops, because every server that trusts
# those keys would refuse the update. See docs/OWNER-SETUP-SIGNING.md.

param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [string]$KeysFile = (Join-Path $PSScriptRoot 'release-keys.txt')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-signature.ps1')

function Set-Output([string]$Name, [string]$Value) {
  # No byte-order mark (Windows PowerShell's -Encoding UTF8 would add one).
  if ($env:GITHUB_OUTPUT) { [System.IO.File]::AppendAllText($env:GITHUB_OUTPUT, "$Name=$Value`n", (New-Object System.Text.UTF8Encoding $false)) }
}

$file = Get-Item -LiteralPath $Setup
$name = $file.Name
if ($name -notmatch '^TohyeeSetup-\d+\.\d+\.\d+\.exe$') { throw "$name isn't TohyeeSetup-<x.y.z>.exe." }
$sigPath = "$($file.FullName).sig"
Remove-Item -LiteralPath $sigPath -Force -ErrorAction SilentlyContinue

$key = [string]$env:TOHYEE_RELEASE_SIGNING_KEY
if (-not $key.Trim()) {
  Write-Host "::warning title=Installer not signed::There's no TOHYEE_RELEASE_SIGNING_KEY secret, so $name isn't signed. Servers that trust a release key will refuse to update to it (docs/OWNER-SETUP-SIGNING.md)."
  Set-Output 'signed' 'false'
  exit 0
}

$text = New-TohyeeReleaseSignature -Path $file.FullName -FileName $name -PrivateKeyXml $key
[System.IO.File]::WriteAllText($sigPath, $text, (New-Object System.Text.UTF8Encoding $false))
$keyId = ([regex]::Match($text, '(?m)^key: ([0-9a-f]+)$')).Groups[1].Value
Write-Host "Signed $name with key $keyId."

$trusted = Get-TohyeeReleaseKeys $KeysFile
if ($trusted.Count -eq 0) {
  Write-Host "::warning title=No public key in release-keys.txt::$name is signed with key $keyId, but release-keys.txt lists no public keys, so servers installed from this release won't check signatures. Add the public key (docs/OWNER-SETUP-SIGNING.md, step 3)."
} else {
  try {
    $result = Test-TohyeeReleaseSignature -Path $file.FullName -FileName $name -SignaturePath $sigPath -KeysPath $KeysFile
  } catch {
    Remove-Item -LiteralPath $sigPath -Force -ErrorAction SilentlyContinue
    throw "The signing key in TOHYEE_RELEASE_SIGNING_KEY (key $keyId) isn't one of the keys in release-keys.txt ($(($trusted | ForEach-Object { $_.Id }) -join ', ')), so servers would refuse this release. Check the secret. ($($_.Exception.Message))"
  }
  Write-Host "Checked: release-keys.txt trusts key $($result.KeyId)."
}
Set-Output 'signed' 'true'
