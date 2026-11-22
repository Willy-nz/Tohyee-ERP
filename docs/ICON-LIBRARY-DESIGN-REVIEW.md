# Icon-library design review — 22 November 2026

## Approved illustrated artwork — 22 November 2026

The 35 farm-specific icons now have **individual, transparent, 96×96 PNG assets** in `public/illustrations/icons/<name>.png`, taken from the five high-quality approved illustration sheets, rather than the first hand-coded sketches. The application now renders these PNGs through `IllustratedIcon`. The earlier `.svg` files are kept only as legacy editable placeholders and are **not the currently displayed artwork**. The icon QA gallery displays the PNGs for farm categories and the original SVGs for shared categories.

PNG is a raster format, not an editable vector. The full-resolution 192×192 crops are also provided separately in the deliverable archive. For a future scale-independent release, trace from the approved images with manual vector QA rather than reverting to simplistic code-generated geometry.

The PNGs are compact palette images optimised for mobile 28–48px. The service worker fetches all 35 by name when it keeps the offline farm pages (`FARM_ICON_URLS` in `public/sw-rules.js`), because the pages draw them after loading and they aren't in a page's HTML. At 96×96 they are soft on a phone at the 48px Log size, and a few are cropped at the edge (near miss, tractor, stock truck, births): the 192×192 crops should replace them.

## Scope examined

- **63 shared SVG illustrations** in `public/illustrations/icons/` on `main` before this change.
- **8 marketing-site icons** in `website/img/icons/`: accounting, AI, analytics, farm, offline, payroll, pipeline and safety. They are byte-for-byte copies of their shared counterparts, so no divergence needs correcting.
- **35 farm-specific icons** from the uploaded Tohyee Farm Icon Brief (15 Log actions; 2 bottom tabs; 7 farm-menu destinations; 6 calendar categories; 5 weather conditions).
- Other graphical assets, including the branded app logo, Android launcher, installed Office icon, photographs and video/web marketing screenshots, have different purposes and must not be redesigned as 64px flat farm icons.

## Findings

The existing shared collection follows an unusually consistent grammar: `64×64` viewBox, dark `#233E45` round `2.4` strokes, and a compact palette of `#B9D9EE`, `#A8D8BF`, `#F3D48B`, `#FFFDF7`. Most use 2–6 shapes and are clear at small sizes. Wholesale replacement would break cohesion and create needless visual churn.

The more meaningful deficits were **missing illustrations** and **mismatched reused pictures**: Medicines used a science flask, Animals a set of scales, Rainfall an effluent symbol, Tractor mode a target and Fertiliser/Pasture shared the same farm picture. The Log menu also lacked the dedicated icon vocabulary. All of those have now been assigned purpose-drawn assets.

## Changes

- Created 35 first-pass SVG sketches, then superseded their on-screen rendering with 35 approved, polished transparent PNG illustrations. The SVG sketches were removed once the PNGs replaced them.
- Prioritised distinct silhouette and direction: cow/gate/arrows for Mob in/out, coiled bale for Feed, plate-meter pole and base, drench applicator, wheeled irrigator, calf, ear tag, tractor and excavator.
- Uses one shared rendering component for new and existing artwork. Existing inline SVGs stay unchanged, while approved PNGs are served as local images. No third-party CDN or product photos.
- Wired **Log buttons, Effluent quick actions, Log/More bottom tabs and Farm More** to the icons; navigation route artwork uses the new destination-specific drawings.
- Added `/illustrations/icon-review.html` for manual checks at 28px and 64px on light/dark surfaces, including all 98 shared/farm icons (new PNGs and original SVGs).

## Browser review checklist

1. Open `/illustrations/icon-review.html` in a local dev/test server. Toggle **28px**, **64px**, and **dark**; verify all images load.
2. At 28px, particularly inspect calf, cow and gate, hay bale, applicator, irrigator, contractor/digger, stock truck and rain gauge. Small details may need simplifying following browser/device feedback.
3. Visit **Farm → Log** and **Farm → More** on a phone and desktop. Check the SVGs do not push text offscreen, clip, overlap badges or lose focus outlines.
4. Verify **offline** behaviour of local PNG image requests on the installed web app. Previously existing inline artwork renders even without a request; the new assets are covered by static caching but should be tested on a real device.
5. Visit a farm with Effluent set up to check Irrigation and Pond Level icons.
6. Test Windows/Android/Apple icon and marketing website branding separately before contemplating changes to their brand marks. They are intentionally preserved.

## Limits

Artwork is not a substitute for actual product photos, medicines packaging or farm safety instructions. These icons are navigation illustrations, not diagnostic information. I inspected the cropped PNG contact sheet and reviewed file structure and paths; **a true browser/device visual review has not been completed**. The complete icon catalogue is available for a human/device pass before merging. The six calendar-job-type icons and five weather-condition icons are prepared for use, but their specialist screens are not yet wired in this PR.

The app's existing internal artwork is intentionally retained, avoiding unnecessary churn to all unrelated modules.
