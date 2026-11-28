# Tohyee icon master style

Updated 28 November 2026. Farm illustration refresh tracked in #121 and #39. The separate future business/accounting redesign remains #125.

## Design direction

Use professionally illustrated, instantly recognizable **icons**, not glossy 3D miniatures or abstract hand-coded shapes.

- Consistent deep navy outlines, rounded corners, restrained light shading and a coherent green, blue, amber and cream palette.
- One dominant, recognizable object per icon; avoid random objects, tiny decorative details, shadows, fake text, embedded captions and mismatched visual metaphors.
- Preserve distinct meanings: mob in/out/move; rainfall vs forecast; near miss vs incident vs hazard; pasture plate meter vs soil sample; treatments vs medicines.
- Transparent backgrounds. All icons must look right on both the pale tiles and dark farm panels.
- Farm-specific artwork is stored as optimized **160×160 PNG** files at `public/illustrations/icons/<name>.png`. They are source-controlled and served locally, no CDN required.
- This file format is intentional: the approved visual assets are raster illustrations; simply rewriting them as rough SVG paths undermines visual quality. Editable vector masters are a separate future effort after visual review.

## Implementation

- The existing `IllustratedIcon` component keeps the farm icon filenames and renders the 35 farm illustrations as local images.
- The same component additionally uses illustrated PNGs for five shared farm-facing icons: `livestock`, `effluent`, `camera`, `quad` (fuel refunds), and `weather`.
- Other shared icons remain unchanged until the business icon pass (#125).
- The service worker precaches both icon groups when saving farm pages offline, and a bumped static cache version refreshes older installations.
- `/illustrations/icon-review.html` shows the local PNGs alongside the remaining SVGs at review sizes.

## QA before / after rollout

1. Compare icons together at **28px, 38px, 48px, and 64px**; ensure subject and direction remain clear.
2. Check light/dark themes and a real mobile screen; verify no image is cut off and captions are not baked into the asset.
3. Visit Farm > Log, Farm > More, Safety, Rainfall, Weather and Animals.
4. Verify service worker pre-cache and offline access, especially after an existing installation upgrades.
5. Run lint, typecheck, build and unit tests in CI.
6. Do not alter the distinct Tohyee brand/app launcher mark without inspecting the existing version and explicit design approval.

## Historical notes

The original 96px raster icons (22 Nov review) and the rejected simplistic SVG experiments (PR #127) explain the prior two-style mismatch. The actual farm UI returned to PNG in PR #128, and this replacement improves that artwork without forcing the low-quality SVG experiment into production.

The dynamic `FarmHero` artwork in `src/components/farm-hero-art.tsx` is separate: its charts, measurements and data-dependent states require a dedicated pass, not interchangeable static icons.

## Shared business illustration refresh — first set (29 November 2026)

Twenty shared icons now use individually cropped and cleaned 160×160 illustrated PNGs from a single consistent design sheet:

`banking`, `sales`, `purchases`, `inventory`, `settings`, `shop`, `team`, `card`, `phone`, `key`, `reassign`, `duplicates`, `form`, `pipeline`, `funnel`, `reports`, `chat`, `mail`, `ai`, and `accounting`.

The renderer selects these by explicit name, preserving the remaining inline shared SVG icons and the previously approved farm artwork. The original SVG copies remain in the repository as design source/fallback rather than being removed. Other shared icons, including the highly repetitive accounting document icons (`credit-note`, `awaiting`, `tax-return`, `receipt`, `tagged-receipt`, etc.), are **not** claimed complete and remain part of #125. Do not swap those for artwork taken from overview infographics until individual image quality has been verified.

Quality checks: view `/illustrations/icon-review.html` at 28px and 64px on light and dark backgrounds. The business PNGs are not pre-fetched for offline farming pages unless needed on those pages; the existing farm offline icon cache is unchanged. App launch/logo artwork remains intentionally unchanged.
