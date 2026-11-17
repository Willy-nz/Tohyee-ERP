# Design principles

A short summary of how Tohyee is built and why. What each feature does is in
[FEATURES.md](FEATURES.md); how it's put together is in
[ARCHITECTURE.md](ARCHITECTURE.md); the accounting rules, with numbers, are
in [ACCOUNTING-EXAMPLES.md](ACCOUNTING-EXAMPLES.md).

## Organisations and data

- **One PostgreSQL database per organisation**, so each can be backed up,
  restored and moved on its own. The core database holds only the server's
  registry, people, sign-ins, memberships and server settings, never
  accounting data.
- Organisation data is only reached through `withOrganisation()` and
  `withOrganisationTransaction()`, which check who is asking and what their
  role allows.
- Who did something comes from the signed-in person, never from what a
  request says.

## Accounting

- Behaviour starts as a **worked example** with real numbers, then a test,
  then code. Where the law, IRD guidance and accounting standards leave a
  choice, Tohyee follows common New Zealand practice and the example says
  so ("following common practice, not yet reviewed").
- **Money and quantities are decimals** (`src/lib/money/decimal.ts`), never
  floating point. Dates are `YYYY-MM-DD`.
- **Posted history is append-only.** A mistake is put right with a new
  journal (a reversal and a replacement, or a void), so the record of what
  happened stays.
- Reports are worked out from the ledger. A **published** report is a frozen
  copy; a **draft** is worked out again each time it's read.
- Nothing records a status someone types in ("backup done") without doing
  the work behind it.

## People and access

- Roles decide what someone can see and change; payroll details are only for
  people given payroll access, and people's pay never appears in Analytics.
- Clients can be given **report viewer** access to just the reports shared
  with them.
- Private mail and personal information stay with the person they belong to.

## AI connections

- An AI works through Tohyee's own tools, at the level an owner chooses:
  drafts only, make and post, or full access.
- Anything that voids, deletes, removes or rolls back is shown first and done
  only on a second call with the preview's code, and an owner can require a
  person to approve it.
- Text from outside the organisation (emailed bills, bank lines, shop
  orders) is information for the AI, never instructions.

## Analytics

- The books, connected sources and uploaded files are copied into an
  organisation's own analytics file; reports never change the books.
- Every saved change to a report is kept in its history and can be put back.

## Running Tohyee

- Self-hosted: the Windows installer, Docker, backups that can be restored
  as a new organisation, and optional remote access.
- A released database migration is never edited: each change is a new
  migration in its own file.
- `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` must
  all pass.

## Writing

- Plain New Zealand English, in Tohyee's own words. Other products' text,
  screens and help pages aren't copied, and they aren't named as the model
  for a feature. Naming another product is only for working with it (an
  import format, a connection).
