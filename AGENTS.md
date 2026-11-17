<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Tohyee project rules

The rules for coding agents are in `.github/copilot-instructions.md`. Read it,
and the docs it lists, before changing anything. The short version:

- One PostgreSQL database per organisation. Don't change the tenancy model.
- Accounting behaviour needs a worked example in `docs/ACCOUNTING-EXAMPLES.md`
  and a test before it's built. If there's no example, see the next rule.
- When a behaviour question has no answer from the owner, follow common New
  Zealand accounting practice (the law, IRD guidance and accounting
  standards first), and mark the worked example "following common practice,
  not yet reviewed" rather than stopping to ask. Write
  the behaviour in your own words: don't copy other products' text, screens
  or help pages, and don't name them as the model. Law, irreversible changes
  and real doubt about what common practice is still go to the owner.
- Money and quantities use `src/lib/money/decimal.ts`, never floats.
- Don't add screens or APIs that only record a status someone types in.
- `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` must all
  pass.
