# Tohyee icon master style

Status: farm vector refresh (see #121, #39); business/accounting expansion tracked in #125.

## Purpose
Icons should read immediately at 28px; they are navigation aids, not tiny realistic illustrations.

## Visual language
- Base grid: 64 × 64 SVG with transparent canvas, generous optical whitespace.
- Stroke: deep slate `#233E45`, rounded joins and caps, nominal 2.8 units.
- Flat colour accents: mint `#A8D8BF`, sky `#B9D9EE`, maize `#F3D48B`, paper `#FFFDF7`; occasional blue `#5B9BD5` for water and muted red for warnings.
- Use a strong main silhouette, only necessary internal details, no photographs, gradient gloss, fake lettering, grass under every icon, or generated-image texture.
- Keep related operations recognizable but distinct (mob in/out direction, soil core versus plate meter, vet versus accident).
- Decorative icons render beside a visible text label and are hidden from assistive technology.

## Asset usage
- Farm SVGs: `public/illustrations/icons/<name>.svg` (35 icons).
- Shared inline SVG artwork: `src/components/illustrated-icon.tsx`.
- Production renders from SVG via `IllustratedIcon`, never 96px PNG crops.
- Existing farm PNGs are retained temporarily as historical fallback; they are not loaded by `IllustratedIcon`.
- Offline icon pre-cache: `public/sw-rules.js` must list SVG files.
- Quality gallery: `/illustrations/icon-review.html`.

## Release QA
1. Check all icons at 28, 38, 48 and 64px on light and dark surfaces; validate in an actual mobile browser.
2. Ensure crops, overlapping forms, and indistinguishable neighbouring actions have been resolved.
3. Check Farm › Log, Farm › More, weather, safety, and offline use.
4. Verify SVG network responses and offline caching on a deployed build.
5. Do not replace the separate brand/launcher artwork until its existing design is reviewed.

## Scope
The 35 farm-specific raster icons are replaced by SVG source art, plus six misleading shared farm icons. The pre-existing shared accounting/business set remains intentionally unchanged until #125.
