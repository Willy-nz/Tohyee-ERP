# Signatures on Tohyee's Windows installer (UPD14-UPD19). Dot-source it:
#   . (Join-Path $PSScriptRoot 'release-signature.ps1')
#
# The release build signs TohyeeSetup-<version>.exe with the owner's private
# key and uploads TohyeeSetup-<version>.exe.sig beside it. Every install
# carries release-keys.txt, the public keys it trusts, so it checks each
# update against the keys it was installed with.
#
# Why RSA and not Ed25519: Windows PowerShell 5.1 and .NET Framework 4.8,
# which every Windows 10 and 11 server already has, can't check Ed25519
# signatures, and we don't want to install anything extra on a server. They
# can check RSA-PSS with SHA-256 (RSACng), and they can make the key pair
# too, so the owner needs nothing extra either.
#
# The .sig file is text:
#   Tohyee release signature 1
#   file: TohyeeSetup-1.2.3.exe
#   sha256: <the installer's SHA-256, lower-case hex>
#   key: <the key's id>
#   signature: <base64>
# What's signed is the first three lines (each ending in a line feed), so a
# signature names the one file it's for: an old signed installer can't be
# passed off under a newer version's name. RSA-PSS, SHA-256, MGF1 with
# SHA-256, a 32-byte salt. A key's id is the first 16 hex digits of the
# SHA-256 of its modulus. The tray app (tray/src/ReleaseSignature.cs) checks
# the same way.

$TohyeeSignatureHeader = 'Tohyee release signature 1'

function New-TohyeeRsa {
  # RSACng on Windows PowerShell 5.1 (RSA.Create() there can't do PSS);
  # RSA.Create() on PowerShell 7, which can, on any system.
  if ($PSVersionTable.PSEdition -eq 'Core') { return [System.Security.Cryptography.RSA]::Create() }
  return New-Object System.Security.Cryptography.RSACng
}

function ConvertTo-TohyeeHex([byte[]]$Bytes) {
  return ([System.BitConverter]::ToString($Bytes) -replace '-', '').ToLowerInvariant()
}

function Get-TohyeeSha256Hex([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TohyeeKeyId([System.Security.Cryptography.RSA]$Rsa) {
  $modulus = $Rsa.ExportParameters($false).Modulus
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return (ConvertTo-TohyeeHex $sha.ComputeHash($modulus)).Substring(0, 16) } finally { $sha.Dispose() }
}

# The bytes that are signed: the first three lines of the .sig file.
function Get-TohyeeSignedText([string]$FileName, [string]$Sha256) {
  return "$TohyeeSignatureHeader`nfile: $FileName`nsha256: $($Sha256.ToLowerInvariant())`n"
}

function Get-TohyeeTextHash([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return $sha.ComputeHash((New-Object System.Text.UTF8Encoding $false).GetBytes($Text)) } finally { $sha.Dispose() }
}

# The public keys in release-keys.txt: one per line (<RSAKeyValue>…), lines
# starting with # are notes. A missing file means no keys.
function Get-TohyeeReleaseKeys([string]$Path) {
  $keys = @()
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return , $keys }
  $number = 0
  foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
    $number++
    $text = $line.Trim()
    if (-not $text -or $text.StartsWith('#')) { continue }
    if ($text.Contains('<D>')) { throw "Line $number of $([System.IO.Path]::GetFileName($Path)) is a private key. Only public keys go there." }
    $rsa = New-TohyeeRsa
    try {
      $rsa.FromXmlString($text)
    } catch {
      throw "Line $number of $([System.IO.Path]::GetFileName($Path)) isn't a public key."
    }
    if ($rsa.KeySize -lt 2048) { throw "Line $number of $([System.IO.Path]::GetFileName($Path)) is a key that's too short (under 2048 bits)." }
    $keys += [pscustomobject]@{ Id = (Get-TohyeeKeyId $rsa); Rsa = $rsa }
  }
  return , $keys
}

# Signs a file with a private key (the XML from docs/OWNER-SETUP-SIGNING.md)
# and returns the .sig file's text.
function New-TohyeeReleaseSignature([string]$Path, [string]$FileName, [string]$PrivateKeyXml) {
  $rsa = New-TohyeeRsa
  try {
    $rsa.FromXmlString($PrivateKeyXml.Trim())
  } catch {
    throw "The signing key isn't a private key in the expected form (<RSAKeyValue> with <D>)."
  }
  if ($rsa.KeySize -lt 2048) { throw 'The signing key is too short (under 2048 bits).' }
  $signed = Get-TohyeeSignedText $FileName (Get-TohyeeSha256Hex $Path)
  $signature = $rsa.SignHash((Get-TohyeeTextHash $signed), [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pss)
  return $signed + "key: $(Get-TohyeeKeyId $rsa)`nsignature: $([System.Convert]::ToBase64String($signature))`n"
}

# Checks the installer at $Path, which should be $FileName, against its .sig
# and the trusted keys. Returns @{ Signed = $true; KeyId } when a trusted key
# signed it, or @{ Signed = $false } when this install trusts no keys (it was
# installed before releases were signed: only the SHA-256 check applies).
# Throws, with a plain reason, when it must not be run.
function Test-TohyeeReleaseSignature([string]$Path, [string]$FileName, [string]$SignaturePath, [string]$KeysPath) {
  $keys = Get-TohyeeReleaseKeys $KeysPath
  if ($keys.Count -eq 0) { return [pscustomobject]@{ Signed = $false; KeyId = $null } }

  if (-not $SignaturePath -or -not (Test-Path -LiteralPath $SignaturePath -PathType Leaf)) {
    throw "$FileName isn't signed, and this Tohyee only installs signed updates, so it wasn't run. Nothing was changed."
  }
  if ((Get-Item -LiteralPath $SignaturePath).Length -gt 16384) { throw "$FileName's signature file is too big to be one, so the installer wasn't run. Nothing was changed." }
  $fields = @{}
  $lines = [System.IO.File]::ReadAllLines($SignaturePath)
  if ($lines.Count -lt 1 -or $lines[0].Trim() -ne $TohyeeSignatureHeader) { throw "$FileName's signature file isn't one Tohyee can read, so the installer wasn't run. Nothing was changed." }
  foreach ($line in ($lines | Select-Object -Skip 1)) {
    if ($line -match '^([a-z0-9]+): (.*)$') { $fields[$Matches[1]] = $Matches[2].Trim() }
  }
  if ($fields['file'] -ne $FileName) { throw "The signature is for $($fields['file']), not $FileName, so the installer wasn't run. Nothing was changed." }
  $actual = Get-TohyeeSha256Hex $Path
  if ($fields['sha256'] -ne $actual) { throw "$FileName doesn't match its signature (it was changed after it was signed), so it wasn't run. Nothing was changed." }
  try {
    $signature = [System.Convert]::FromBase64String([string]$fields['signature'])
  } catch {
    throw "$FileName's signature isn't readable, so the installer wasn't run. Nothing was changed."
  }
  $hash = Get-TohyeeTextHash (Get-TohyeeSignedText $FileName $actual)
  foreach ($key in $keys) {
    $ok = $false
    try {
      $ok = $key.Rsa.VerifyHash($hash, $signature, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pss)
    } catch {
      $ok = $false
    }
    if ($ok) { return [pscustomobject]@{ Signed = $true; KeyId = $key.Id } }
  }
  throw "$FileName isn't signed by a key this Tohyee trusts, so it wasn't run. Nothing was changed."
}
