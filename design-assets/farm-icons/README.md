# Tohyee farming illustration assets

This folder contains the **35 illustrated farm icons** selected for Tohyee's Farm module.

## Where they are used

- `public/illustrations/icons/<name>.png` — 192 × 192 RGBA PNG files used by the Farm UI, resized from the 1024 × 1024 copies below. The screens show them at 48px at most, so 192px is sharp on any phone, and all 35 come to about 1.5 MB to fetch and keep offline (512px was 6 MB). To remake one: `convert masters-1024/<name>.png -filter Lanczos -resize 192x192 -strip <name>.png`.
- `design-assets/farm-icons/masters-1024/<name>.png` — corresponding 1024 × 1024 RGBA PNG copies for larger display/export.

## Provenance and limitations

The images were cropped from five **image-generated, transparent icon sheets** approved in the Tohyee design conversation. Every crop was checked together in a 35-icon contact sheet. Artwork is centred with transparent padding and no baked-in captions or cards.

The original illustrated subjects measure roughly **258–594 source pixels** across, depending on the icon and sheet. **Both the 192px and 1024px files have been resampled** from those source images. The 1024px assets are larger working files, **not independently generated native-1024 detail** and not vector SVGs. Avoid claiming they contain 1024 pixels of independently drawn detail; future truly native high-resolution artwork would need fresh individual renders or carefully verified vector tracing.

The illustrations use the polished farm design language: dark-teal outlines and soft yellow, blue, green and cream fills. They are generic illustrations, not photos or specific medicines.

## Icon list

- Farm log: `farm-walk`, `mob-in`, `mob-out`, `cover-reading`, `feed`, `rain-gauge`, `move-mob`, `births`, `deaths`, `treatment`, `hazard`, `near-miss`, `incident`, `irrigation`, `pond-level`.
- Farm tabs: `log`, `more`.
- Farm menu: `pasture`, `fertiliser`, `rainfall`, `soil-test`, `tractor`, `medicines`, `animal-tag`.
- Calendar: `stock-truck`, `vet`, `delivery`, `contractor`, `meeting`, `deadline`.
- Weather: `sun`, `cloud`, `rain`, `wind`, `frost`.

## QA before merging

Run `npm run typecheck`, `npm run lint` and the tests. Check `/illustrations/icon-review.html` with the new PNG files, on phone and desktop, including dark mode and 28px icon display. Verify offline loading in a previously opened Farm screen. This change does not alter any accounting/farming calculations.

For the original full-sized review gallery and ready-to-download PNG exports, see the relevant ChatGPT conversation artifact. 
