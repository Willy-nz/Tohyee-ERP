# Setting up release signing (for the repository owner)

This sets up four things, once:

- **A. The Windows installer key.** Tohyee servers check that each update
  was signed by you before they install it (UPD14-UPD19).
- **B. The GitHub secret** that lets the release build sign with that key.
- **C. The Android app key**, so a newer app installs over the old one.
- **D. Branch protection**, so nothing reaches `main` without passing the checks.

You need a Windows computer, a GitHub sign-in with owner rights on the
repository, and **two USB sticks** (one to keep the keys, one as a backup).
Nothing here costs money.

Everything you type goes into **Windows PowerShell**: press Start, type
`PowerShell`, and open **Windows PowerShell**. Copy each command exactly.
Where a command says `E:`, use the letter Windows gave your USB stick (look
in File Explorer under **This PC**).

## Keep these files safe

- The files ending in `PRIVATE-key.xml` and `.keystore` are your private
  keys. Anyone who has them, plus access to the repository, could make a
  release that Tohyee servers or phones accept.
- Keep them only on the two USB sticks. Don't put them in OneDrive, Google
  Drive, email or a chat, and never in the repository.
- Put the USB sticks somewhere safe and apart (one at home, one elsewhere).
- Keep the Android keystore password in your password manager.

## A. Make the Windows installer key

1. Plug in the first USB stick. Note its drive letter (say `E:`).
2. In Windows PowerShell, run this (all lines at once). It makes the key
   straight onto the USB stick:

   ```powershell
   $folder = "E:\Tohyee signing key"
   New-Item -ItemType Directory -Force -Path $folder | Out-Null
   $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider 3072
   [IO.File]::WriteAllText("$folder\tohyee-release-PRIVATE-key.xml", $rsa.ToXmlString($true))
   [IO.File]::WriteAllText("$folder\tohyee-release-public-key.txt", $rsa.ToXmlString($false))
   $rsa.Clear()
   Get-ChildItem $folder
   ```

   You should see the two files listed.
3. Plug in the second USB stick (say `F:`) and copy the folder to it as
   the backup:

   ```powershell
   Copy-Item -Recurse "E:\Tohyee signing key" "F:\"
   ```

## B. Let the release build sign with it

1. Put the private key on the clipboard:

   ```powershell
   Get-Content "E:\Tohyee signing key\tohyee-release-PRIVATE-key.xml" -Raw | Set-Clipboard
   ```

2. On GitHub, open the repository › **Settings** › **Secrets and
   variables** › **Actions** › **New repository secret**.
3. **Name:** `TOHYEE_RELEASE_SIGNING_KEY`. **Secret:** paste (Ctrl+V).
   Press **Add secret**.
4. Clear the clipboard:

   ```powershell
   Set-Clipboard -Value " "
   ```

5. Put the **public** key in the repository, so servers know to trust it.
   Put it on the clipboard:

   ```powershell
   Get-Content "E:\Tohyee signing key\tohyee-release-public-key.txt" -Raw | Set-Clipboard
   ```

6. On GitHub, open `installer/windows/release-keys.txt`, press the pencil
   (Edit), go to the end of the file, start a new line and paste. The line
   starts with `<RSAKeyValue><Modulus>`. Check it does **not** contain
   `<D>` (if it does, it's the private key: don't save it). Press **Commit
   changes**, choose **Create a new branch and start a pull request**, and
   merge the pull request when its checks pass.

Do step B.3 (the secret) before B.6 (the public key). A release made with
the public key but without the secret isn't signed, and servers that trust
the key would refuse it.

**What happens next:**

- The next release is signed (its `TohyeeSetup-<version>.exe.sig` is beside
  the installer) and carries your public key.
- Servers installed before this don't check signatures. They install that
  release as before (checked against its SHA-256), and from then on they
  only install updates you signed.
- If a release can't be signed (the secret is missing), its notes say "Windows
  installer not signed", and servers that trust your key won't install it
  with Update now. The build checks that the secret matches a key in
  `release-keys.txt`, and stops if it doesn't.

## C. Make the Android app key

1. Install Java (it has the `keytool` program). In Windows PowerShell:

   ```powershell
   winget install --id EclipseAdoptium.Temurin.21.JDK -e
   ```

   Then close Windows PowerShell and open it again.
2. Make the keystore on the USB stick. It asks for a password twice: make
   a long one and save it in your password manager.

   ```powershell
   keytool -genkeypair -v -keystore "E:\Tohyee signing key\tohyee-release.keystore" -storetype PKCS12 -alias tohyee -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Tohyee, O=Tohyee, C=NZ"
   ```

3. Copy it to the backup stick:

   ```powershell
   Copy-Item "E:\Tohyee signing key\tohyee-release.keystore" "F:\Tohyee signing key\"
   ```

4. Put the keystore on the clipboard, as text:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("E:\Tohyee signing key\tohyee-release.keystore")) | Set-Clipboard
   ```

5. On GitHub › **Settings** › **Secrets and variables** › **Actions**, add
   four secrets with **New repository secret**:

   | Name | Secret |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | paste (Ctrl+V) |
   | `ANDROID_KEYSTORE_PASSWORD` | the password from step 2 |
   | `ANDROID_KEY_ALIAS` | `tohyee` |
   | `ANDROID_KEY_PASSWORD` | the same password again |

6. Clear the clipboard: `Set-Clipboard -Value " "`

**What happens next:** releases have `Tohyee-<version>.apk`, signed with
this key, and each one installs over the one before. The first one can't
replace a test build ("Tohyee (test)") already on a phone: install the new
app, type the Tohyee address, then uninstall the test one. Without these
secrets a release has only the test build, and its notes say so.

## D. Turn on branch protection for main

1. On GitHub, open the repository › **Settings** › **Branches** › **Add
   branch protection rule** (or **Add classic branch protection rule**).
2. **Branch name pattern:** `main`
3. Tick **Require a pull request before merging**. If you're the only
   person working on it, untick **Require approvals** (otherwise you can't
   merge your own pull requests).
4. Tick **Require status checks to pass before merging**. In the search box
   type `Checks`, and add both **Checks (Node 22)** and **Checks (Node 24)**.
   (They only appear if they've run in the last week: open any pull
   request first if they don't.)
5. Leave **Allow force pushes** and **Allow deletions** unticked.
6. Press **Create** (or **Save changes**).

Now a change, including a new version number (which makes a release), only
reaches `main` through a pull request whose checks passed.

## If a key is lost or stolen

**Windows key lost** (both USB sticks): you can't sign updates any more, and
servers that trust only that key refuse every new update. Make a new key
(part A), replace the `TOHYEE_RELEASE_SIGNING_KEY` secret, and replace the
old line in `release-keys.txt` with the new public key. Then, on each
server computer, download the new `TohyeeSetup-<version>.exe` from the
release page once and run it by hand. That install trusts the new key, and
Update now works again after it.

**Windows key stolen:** do the same as for a lost key, straight away, and
change your GitHub password and tokens.

**Changing the Windows key on purpose** (no rush): add the new public key
as a second line in `release-keys.txt` and make a release still signed
with the old key. Servers update to it and now trust both keys. Then put
the new private key in the secret and, in a later release, remove the old
line.

**Android key or password lost:** Android only installs an update signed
with the same key, so nobody's app can be updated any more. Make a new
keystore (part C) and replace the four secrets. The release build stops
when the key changes, to catch mistakes: for the one release that changes
it on purpose, add a repository **variable** (Settings › Secrets and
variables › Actions › **Variables** tab) named `ANDROID_ALLOW_NEW_KEY` with
the value `yes`, and delete it after that release. Everyone then has to
uninstall the app and install the new one, which loses what the app saved
on their phone (its address, and anything not yet sent).

**Android key stolen:** someone could make an app that installs over
Tohyee on a phone. Do the same as for a lost key, and tell people to
reinstall only from Tohyee's release page.
