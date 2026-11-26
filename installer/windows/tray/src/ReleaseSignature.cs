using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Tohyee.Tray
{
    /// <summary>What the signature check found (UPD14-UPD19).</summary>
    internal sealed class SignatureCheck
    {
        /// <summary>True when a key this install trusts signed the installer.</summary>
        public bool Signed;

        /// <summary>The key that signed it (16 hex digits), when signed.</summary>
        public string KeyId;
    }

    /// <summary>Why an installer mustn't be run. The message is for people.</summary>
    internal sealed class SignatureRefused : Exception
    {
        public SignatureRefused(string message) : base(message)
        {
        }
    }

    /// <summary>
    /// Checks TohyeeSetup-&lt;version&gt;.exe against its .sig file and the public
    /// keys this install trusts (scripts\release-keys.txt, installed with it),
    /// exactly as installer\windows\release-signature.ps1 does for the
    /// updater: RSA-PSS with SHA-256 (MGF1 SHA-256, 32-byte salt) over the
    /// .sig file's first three lines, which name the file and its SHA-256.
    /// With no trusted keys (installed before releases were signed) it says
    /// "not signed" and the SHA-256 check is all there is.
    /// </summary>
    internal static class ReleaseSignature
    {
        public const string Header = "Tohyee release signature 1";
        private const int MaxSignatureFile = 16384;

        /// <summary>The keys file installed beside the server app ({app}\scripts\release-keys.txt).</summary>
        public static string KeysFile
        {
            get { return Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "scripts", "release-keys.txt")); }
        }

        public static string KeyId(RSA rsa)
        {
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(rsa.ExportParameters(false).Modulus);
                return Hex(hash).Substring(0, 16);
            }
        }

        /// <summary>The trusted public keys: one &lt;RSAKeyValue&gt; per line; # starts a note. A missing file means none.</summary>
        public static List<KeyValuePair<string, RSA>> LoadKeys(string path)
        {
            var keys = new List<KeyValuePair<string, RSA>>();
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return keys;
            var name = Path.GetFileName(path);
            var number = 0;
            foreach (var line in File.ReadAllLines(path))
            {
                number++;
                var text = line.Trim();
                if (text.Length == 0 || text.StartsWith("#", StringComparison.Ordinal)) continue;
                if (text.Contains("<D>")) throw new SignatureRefused("Line " + number + " of " + name + " is a private key. Only public keys go there.");
                var rsa = new RSACng();
                try
                {
                    rsa.FromXmlString(text);
                }
                catch (Exception)
                {
                    throw new SignatureRefused("Line " + number + " of " + name + " isn't a public key.");
                }
                if (rsa.KeySize < 2048) throw new SignatureRefused("Line " + number + " of " + name + " is a key that's too short (under 2048 bits).");
                keys.Add(new KeyValuePair<string, RSA>(KeyId(rsa), rsa));
            }
            return keys;
        }

        public static string SignedText(string fileName, string sha256)
        {
            return Header + "\nfile: " + fileName + "\nsha256: " + sha256.ToLowerInvariant() + "\n";
        }

        /// <summary>Checks the installer, or throws SignatureRefused with why it mustn't be run.</summary>
        public static SignatureCheck Check(string file, string fileName, string signatureFile, string keysFile)
        {
            var keys = LoadKeys(keysFile);
            if (keys.Count == 0) return new SignatureCheck { Signed = false };

            if (string.IsNullOrEmpty(signatureFile) || !File.Exists(signatureFile))
            {
                throw new SignatureRefused(fileName + " isn't signed, and this Tohyee only installs signed updates, so it wasn't run. Nothing was changed.");
            }
            if (new FileInfo(signatureFile).Length > MaxSignatureFile)
            {
                throw new SignatureRefused(fileName + "'s signature file is too big to be one, so the installer wasn't run. Nothing was changed.");
            }
            var lines = File.ReadAllLines(signatureFile);
            if (lines.Length < 1 || lines[0].Trim() != Header)
            {
                throw new SignatureRefused(fileName + "'s signature file isn't one Tohyee can read, so the installer wasn't run. Nothing was changed.");
            }
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            for (var i = 1; i < lines.Length; i++)
            {
                var match = Regex.Match(lines[i], "^([a-z0-9]+): (.*)$");
                if (match.Success) fields[match.Groups[1].Value] = match.Groups[2].Value.Trim();
            }
            string signedFile, signedHash, signatureText;
            fields.TryGetValue("file", out signedFile);
            fields.TryGetValue("sha256", out signedHash);
            fields.TryGetValue("signature", out signatureText);
            if (signedFile != fileName)
            {
                throw new SignatureRefused("The signature is for " + signedFile + ", not " + fileName + ", so the installer wasn't run. Nothing was changed.");
            }
            var actual = UpdateInstaller.Sha256Of(file);
            if (signedHash != actual)
            {
                throw new SignatureRefused(fileName + " doesn't match its signature (it was changed after it was signed), so it wasn't run. Nothing was changed.");
            }
            byte[] signature;
            try
            {
                signature = Convert.FromBase64String(signatureText ?? "");
            }
            catch (FormatException)
            {
                throw new SignatureRefused(fileName + "'s signature isn't readable, so the installer wasn't run. Nothing was changed.");
            }
            byte[] hash;
            using (var sha = SHA256.Create())
            {
                hash = sha.ComputeHash(new UTF8Encoding(false).GetBytes(SignedText(fileName, actual)));
            }
            foreach (var key in keys)
            {
                bool ok;
                try
                {
                    ok = key.Value.VerifyHash(hash, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
                }
                catch (CryptographicException)
                {
                    ok = false;
                }
                if (ok) return new SignatureCheck { Signed = true, KeyId = key.Key };
            }
            throw new SignatureRefused(fileName + " isn't signed by a key this Tohyee trusts, so it wasn't run. Nothing was changed.");
        }

        /// <summary>
        /// TohyeeTray.exe --verify-release &lt;file&gt; &lt;name&gt; &lt;sig&gt; &lt;keys&gt; &lt;result file&gt;:
        /// the same check from the command line, for installer\windows\test-release-signature.ps1.
        /// Exit code 0 signed, 3 not signed (no trusted keys), 2 refused.
        /// </summary>
        public static int CommandLine(string[] args)
        {
            if (args.Length < 6) return 64;
            string answer;
            int code;
            try
            {
                var result = Check(args[1], args[2], args[3], args[4]);
                answer = result.Signed ? result.KeyId : "not signed";
                code = result.Signed ? 0 : 3;
            }
            catch (SignatureRefused refused)
            {
                answer = refused.Message;
                code = 2;
            }
            catch (Exception error)
            {
                answer = "Error: " + error.Message;
                code = 1;
            }
            File.WriteAllText(args[5], answer);
            return code;
        }

        private static string Hex(byte[] bytes)
        {
            return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
        }
    }
}
