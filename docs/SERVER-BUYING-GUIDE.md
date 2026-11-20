# Choose a computer and set up your Tohyee server

A beginner-friendly buying and installation guide, focused on the **Windows installer**. [View the website version](../website/server-guide.html).

> Tohyee is in early development. Start with a demo organisation, test backups and recovery, and review accounting outputs before relying on them. This is buying advice, not a guarantee of capacity for a particular workload.

## 1. What is a Tohyee server?

The server is an ordinary computer that runs Tohyee and PostgreSQL. You use Tohyee through a browser on that computer or another device. The computer hosting it should remain powered on, connected to the network and protected by backups. A separate monitor isn't needed once you have set it up (although one helps with maintenance).

**For most small teams:** a refurbished business mini PC or modern mini PC, with Windows, an SSD, wired Ethernet and a backup plan, is a practical starting point. **You don't need an expensive rack server or gaming graphics card.**

## 2. What to look for when buying

| Part | Sensible starting point | If you expect many organisations, imports or Analytics workloads |
| --- | --- | --- |
| Processor | Modern 64-bit Intel Core i3/i5, AMD Ryzen 3/5, or equivalent | Recent Core i5/i7 or Ryzen 5/7, ideally 6+ capable cores |
| Memory | **16 GB RAM** | **32 GB RAM** (and room to upgrade further) |
| Storage | **500/512 GB SSD** | **1 TB NVMe SSD** or larger if source files and backups are local |
| Network | **Gigabit Ethernet** to your router/switch | Wired networking, reliable broadband and ideally backup connectivity |
| Operating system | Supported **Windows 11** with updates | Windows 11 for the packaged installer; Linux/Docker only if comfortable maintaining it |
| Recovery | Separate backup destination and a recovery-kit copy | Independent off-site backups, tested restores, UPS for outages |

These are **recommended purchasing targets**, not official measured minimum requirements. Actual capacity depends on database size, concurrent users, source imports and other workloads. A dedicated server avoids interruptions from games, heavy desktop work or sleep settings.

### New versus refurbished

- **Refurbished office mini PC:** often the best value. Check that it officially supports Windows 11, has a valid Windows licence, at least 16 GB of RAM, a healthy replaceable SSD, Ethernet, included power adapter and a meaningful return policy.
- **New mini PC:** look for 16–32 GB RAM, a reputable SSD, good cooling, support/warranty and a current supported Windows release. Don't choose on processor marketing alone; check RAM and storage are upgradeable.
- **An existing computer:** fine for a small test or even a production deployment if it is reliable, compatible, stays on and has verified backups. Don't use a Windows 10-only machine for a new internet-connected setup.
- **NAS or Raspberry Pi:** not the default beginner route. The packaged Windows installer is the straightforward path; alternative platforms need separate compatibility and maintenance work.

**Before buying**, confirm: Windows 11 support, licence, RAM, SSD health/capacity, Ethernet, BIOS/power-on options, warranty and physical security. Budget for backups and a small UPS rather than spending the entire amount on CPU.

## 3. Prepare the computer

1. Install and update Windows 11. Set a strong password on the Windows administrator account and enable disk encryption where available. Keep Windows Defender and the firewall enabled.
2. Connect Ethernet to the router. Put the PC somewhere dry, ventilated and physically secure. Plug the PC and router into a suitably sized UPS if outages are common.
3. Set Windows power settings so it does **not sleep** when plugged in. A display can turn off; the server computer must not. In BIOS/UEFI, consider **restore power after AC loss**.
4. Enable automatic Windows security updates, and plan occasional restarts. Keep the machine for Tohyee instead of installing unnecessary software. Do not forward database port **5432** or Tohyee's application port **3000** from the internet.
5. Choose where encrypted backups will go. A cloud-synced folder alone is not proof of successful upload, so plan another independent copy as well.

## 4. Install Tohyee on Windows

1. On the server, visit the [official release downloads](https://github.com/Willy-nz/Tohyee-ERP/releases/latest).
2. Download the matching **`TohyeeSetup-<version>.exe`** Windows server installer. Read that release's notes. Avoid unknown third-party installer links.
3. Run the installer. It sets up the **Tohyee** and **TohyeePostgres** Windows services, which start when Windows starts, without requiring a user to sign in. It installs its own PostgreSQL; you don't need to download PostgreSQL separately.
4. Keep the setup token shown at the end of installation private. Open **Open Tohyee** from the Start menu, or browse to [http://localhost:3000](http://localhost:3000) on the server itself. Create the first server administrator using the token.
5. Open the **Tohyee server app** near the Windows clock (or **Tohyee server settings** from Start). Under **Organisations**, create your organisation or first add the fictional **demo farm** to explore safely.
6. Sign in to Tohyee, check modules, roles and permissions, and confirm you can open the app after a reboot.

Data and settings live in `%ProgramData%\Tohyee`. They are retained by updates and uninstall; that **does not replace backups**. Check the installer/release notes for changes before upgrading.

## 5. Use Tohyee on another computer or phone

For a device in your office, access Tohyee using a **trusted local network** and the server's LAN address, subject to Windows firewall and network configuration. Never expose a plain HTTP service over the public internet.

For remote users, configure **Remote access** from the local Tohyee server app. Supported options described by the project are:

- **Cloudflare Tunnel with your own domain:** connect your Cloudflare account, pick a hostname and use HTTPS without opening router ports.
- **Tailscale Funnel on Windows:** follow the in-app Tailscale setup, and check the provider's current business plan terms.
- **Tohyee-managed address:** the repository currently notes that the address service is **not running yet**. Do not rely on it when buying or deploying.

Set up two-step sign-in and **Email** in server settings for security alerts and recovery links. Check access from a phone on mobile data, then check that unauthorised users cannot access administration screens.

## 6. Make backups work before entering real books

Tohyee makes **encrypted nightly backups** of each organisation and its own server database, retaining **14 daily and 12 monthly** backups by default. A backup is useful only if you can restore it.

1. In the local server app's **Backups** section, select a destination (ideally a cloud-synced folder plus independent storage).
2. Run **Back up now**. Confirm that the job passed and the backup exists in the chosen folder.
3. Confirm any cloud copy actually uploaded by checking the provider website. The Tohyee screen **cannot verify** an external cloud sync.
4. Export the **recovery kit** and save its recovery code in a password manager or its protected file and passphrase separately. **Never store the only copy beside the backups.**
5. Use Backups to **check your saved recovery kit**. Keep another independent backup copy offline or off-site.
6. Practise **restore as a copy** on a suitable test/replacement computer, and verify access. Restoring must not overwrite the live business.

See the [backups and recovery design](BACKUP-RECOVERY.md) for the precise scope and limitations.

## 7. Test the whole setup

- Reboot: both Windows services start; the app opens; users can sign in.
- On a different device: the app opens, and remote users have HTTPS and two-step authentication.
- Check Windows updates, power/sleep settings, available SSD space, Windows event logs and Tohyee's server status periodically.
- Run a backup, confirm off-site sync, and practise a restore. Recheck after meaningful upgrades.
- Keep admin accounts limited, give staff only the access they need, and promptly apply supported software and operating-system updates.

## 8. When to buy a bigger computer

Start at 16 GB RAM/SSD for a small team; choose 32 GB or more if you are managing many organisations, large Analytics source data, frequent imports, or other services on the same PC. Watch actual memory use, SSD space, backup duration and response times instead of relying on made-up user-count limits. Move to a dedicated server/virtual machine with monitored backups if the system becomes business-critical.

**Help:** [Tohyee releases](https://github.com/Willy-nz/Tohyee-ERP/releases/latest) · [Current features and limitations](FEATURES.md) · [Report a problem](https://github.com/Willy-nz/Tohyee-ERP/issues) · [Project README](../README.md#running-on-a-server).
