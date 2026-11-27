# A backup server at a second place

Two Tohyee servers: the **main** one everyone uses, and a **backup** one at a
second place that keeps a copy and can take over if the main is lost. The
plan and its decisions are in issue #11; the rules, with worked examples,
are BKS1 to BKS22 in `docs/ACCOUNTING-EXAMPLES.md`.

What it protects against: fire, theft, flood, a dead computer. What it
doesn't: a mistake or ransomware is copied to the backup too, so the older
backups (14 days, 12 months) still matter. Up to an hour of work can be
lost at a switch-over.

Nothing here has been tried on two real computers yet. Practise before
relying on it.

## What you need

- A second computer, always on, at another address, with Tohyee freshly
  installed (no organisations) at the **same version** as the main.
- A folder that syncs between the two computers (a cloud-synced folder,
  for example). The two servers never talk to each other: the folder is
  the only thing they share.
- The main's recovery kit (its code, or its file and passphrase).
- A way to reach the backup server from outside that doesn't depend on the
  main's: its own remote access, set up and tried.

## Setting up

On the **main**:

1. Server › Backups: set the folder to the synced one, and "How often" to
   **Every hour**.
2. Save the recovery kit if you haven't.

On the **backup** computer:

1. Install Tohyee. Make the first admin login. Don't make an organisation.
2. Sign the computer in to the same sync, and wait for the main's backups
   to appear in the folder.
3. Open Tohyee on that computer, **Server › Backup server**. Give the
   folder and the main's recovery kit. Press **Make this a backup server**.
4. **Restart Tohyee** on that computer.
5. Within a few minutes the copies appear on that page, each with the time
   its books are as at. People sign in there with the same email, password
   and two-step code as on the main.
6. Give it the main's outside address under "Can the main server be
   reached?", so it can tell you when the main stops answering.
7. Set up email on the backup server (Server › Email) if you want its
   alerts by email. Server settings aren't copied from the main.
8. Set up its own remote access, and try it from a phone on mobile data.
9. Press **Practise a switch-over**. Fix whatever it lists.

The main's Backups page now shows a "Backup server" card with the time the
backup server last took copies.

## Day to day

- The backup server takes no changes and runs no automatic jobs. Only
  server admins can look at it.
- It holds the main's organisations and no others. One removed on the main
  is archived on the backup for 30 days, then deleted.
- Each server emails its admins when the other goes quiet.
- Update both servers together. A backup server on an older version can't
  open the main's newer backups, and says so.
- Practise a switch-over every 6 months. The page reminds you.

## Switching over

Only when the main is lost or can't be reached and won't be back soon.
Tohyee never switches by itself.

1. Make sure the old main is **off**, if you can get to it.
2. Sign in to the backup server and open **Switch over** (the banner links
   to it). A server admin can, and so can an organisation's Owner.
3. Read what time each copy is as at. Anything entered on the main after
   that isn't there.
4. Say why, type your password again, tick that the old main is off, and
   press **Make this the main server**.
5. On the server computer: restart Tohyee; set where it backs up; save its
   **new** recovery kit; reconnect AI and app connections.
6. Tell everyone the address to use.

Not carried over: AI and app connections, sign-in sessions (people sign in
again), and groups of organisations for combined reports (consolidation
groups and their chart mapping), which are kept in the server's own
database and have to be set up again.

## When the old main comes back

It finds a note in the backups folder saying the main has moved, and
**stops**: no changes, no jobs. People can still read what's on it.

- Usual: note down anything that was entered on it after the copy's time,
  then pair it as the backup server (Server › Backup server), pointing at
  the folder the new main backs up into. Its books become copies.
- To go back to the original computer: once it's the backup server and up
  to date, switch over again from it.
- If the switch-over was a mistake: on that computer, a server admin
  presses **This is the main server after all**, and the other server is
  stopped. Never run two mains.

If the note couldn't be written at the switch-over (the folder wasn't
reachable), the Switch over screen says so: keep the old main off until
it's been dealt with by hand.

## From the command line

```
npm run admin -- backups set --every hour --folder PATH
npm run admin -- backup-server status
npm run admin -- backup-server pair --folder PATH
npm run admin -- backup-server refresh
npm run admin -- backup-server main-address https://books.example.nz
npm run admin -- backup-server practise
npm run admin -- backup-server make-main --reason "Why" --old-main-is-off
npm run admin -- backup-server main-after-all
```

## Not built

- A page for this in the Windows server app: use the web Server pages on
  the server computer, or the command line.
- Moving the outside address from one server to the other by itself.
- Copying AI connections and groups of organisations.
