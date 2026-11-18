import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { checkAttachment } from "@/lib/records/file-types";

/**
 * Images on Analytics reports. Stored in the
 * organisation's database like record attachments, checked the same way
 * (the type from the name, confirmed by the contents), JPG and PNG only, up
 * to 5 MB. An image belongs to one report: reading it needs the same access
 * as reading the report, which the routes check first.
 *
 * A picture taken off the report is kept while a version in the report's
 * History still uses it (PIC4), so putting that version back brings the
 * picture back too. It's removed when no kept version uses it any more.
 */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Pictures a report shows at once. */
export const MAX_IMAGES_PER_DASHBOARD = 40;
/** Pictures kept for a report, counting those only its History still uses. */
export const MAX_IMAGES_KEPT = 200;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

export type StoredImage = { id: string; fileName: string; contentType: string; byteSize: number };

export async function addDashboardImage(tx: OrgTx, dashboardId: string, file: { fileName: string; content: Uint8Array }): Promise<StoredImage> {
  const checked = checkAttachment(file.fileName, file.content);
  if (!IMAGE_TYPES.has(checked.contentType)) throw new ValidationError(`${checked.fileName} can't be used: a report's images are JPG or PNG.`);
  if (file.content.length > MAX_IMAGE_BYTES) throw new ValidationError(`${checked.fileName} is too big: a report's images can be up to 5 MB.`);
  if ((await imagesInUse(tx, dashboardId)).length >= MAX_IMAGES_PER_DASHBOARD) throw new ValidationError(`A report can have up to ${MAX_IMAGES_PER_DASHBOARD} images.`);
  const kept = await tx.query<{ count: string }>("select count(*)::text as count from analytics_dashboard_images where dashboard_id = $1", [dashboardId]);
  if (Number(kept.rows[0]?.count ?? 0) >= MAX_IMAGES_KEPT) throw new ValidationError(`This report keeps ${MAX_IMAGES_KEPT} pictures, counting the ones its History still uses. Take off a picture it doesn't need, or start a new report.`);
  const result = await tx.query<{ id: string }>(
    `insert into analytics_dashboard_images (dashboard_id, file_name, content_type, byte_size, content, created_by_email)
     values ($1, $2, $3, $4, $5, $6) returning id::text`,
    [dashboardId, checked.fileName, checked.contentType, file.content.length, Buffer.from(file.content), tx.actor.email],
  );
  const id = result.rows[0].id;
  await writeAuditEvent(tx, { eventType: "analytics.dashboard_image_added", entityType: "analytics_dashboard", entityId: dashboardId, details: { image: id, fileName: checked.fileName } });
  return { id, fileName: checked.fileName, contentType: checked.contentType, byteSize: file.content.length };
}

export async function readDashboardImage(tx: OrgTx, dashboardId: string, imageId: string): Promise<{ fileName: string; contentType: string; content: Uint8Array }> {
  const id = /^\d{1,18}$/.test(imageId) ? imageId : "0";
  const result = await tx.query<{ file_name: string; content_type: string; content: Buffer }>(
    "select file_name, content_type, content from analytics_dashboard_images where id = $1 and dashboard_id = $2",
    [id, dashboardId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("That image wasn't found.");
  return { fileName: row.file_name, contentType: row.content_type, content: new Uint8Array(row.content) };
}

/**
 * When a report's tiles are saved: every image tile must use one of this
 * report's images, and images no tile uses any more are removed (an image
 * uploaded and then not used, or a removed image tile).
 */
export async function checkDashboardImages(
  tx: OrgTx,
  dashboardId: string,
  tiles: Array<{ title: string; visual: string; image?: { id: string } }>,
  /** Images the report's pages use as backgrounds: kept, and checked, like a tile's. */
  pagePictures: string[] = [],
  coverImageId?: string,
): Promise<void> {
  const used = [...tiles.flatMap((tile) => (tile.visual === "image" && tile.image ? [tile.image.id] : [])), ...pagePictures, ...(coverImageId ? [coverImageId] : [])];
  const result = await tx.query<{ id: string }>("select id::text from analytics_dashboard_images where dashboard_id = $1", [dashboardId]);
  const own = new Set(result.rows.map((row) => row.id));
  const missing = tiles.find((tile) => tile.visual === "image" && tile.image && !own.has(tile.image.id));
  if (missing) throw new ValidationError(`${missing.title}: that image isn't one of this report's. Upload it again.`);
  if (pagePictures.some((id) => !own.has(id))) throw new ValidationError("A page's background picture isn't one of this report's. Upload it again.");
  if (coverImageId && !own.has(coverImageId)) throw new ValidationError("That cover picture isn't one of this report's. Upload it again.");
  // Kept while a version in the report's History uses it, so putting that version back brings it back (PIC4).
  await tx.query(
    `delete from analytics_dashboard_images image
      where image.dashboard_id = $1 and not (image.id = any($2::bigint[]))
        and not exists (
          select 1 from analytics_dashboard_history version
           where version.dashboard_id = $1 and image.id::text = any(${USED_IN_VERSION}))`,
    [dashboardId, used],
  );
}

/** The image ids one saved definition uses (tiles and page backgrounds), in SQL over a row called `version`. */
const USED_IN_VERSION = `array(
  select tile->'image'->>'id' from jsonb_array_elements(case when jsonb_typeof(version.tiles) = 'array' then version.tiles else '[]'::jsonb end) tile
   where tile->>'visual' = 'image'
  union all
  select page->'picture'->>'id' from jsonb_array_elements(case when jsonb_typeof(version.settings->'pages') = 'array' then version.settings->'pages' else '[]'::jsonb end) page
   where page ? 'picture'
  union all
  select version.settings->>'coverImageId' where version.settings ? 'coverImageId')`;

/** The images the report uses now: its image tiles and page backgrounds. */
export async function imagesInUse(tx: OrgTx, dashboardId: string): Promise<string[]> {
  const result = await tx.query<{ ids: string[] | null }>(`select ${USED_IN_VERSION} as ids from analytics_dashboards version where version.id = $1`, [dashboardId]);
  return (result.rows[0]?.ids ?? []).filter((id): id is string => typeof id === "string");
}

/** Each of a report's pictures' file names, by id. */
export async function imageNames(tx: OrgTx, dashboardId: string): Promise<Map<string, string>> {
  const result = await tx.query<{ id: string; file_name: string }>("select id::text, file_name from analytics_dashboard_images where dashboard_id = $1", [dashboardId]);
  return new Map(result.rows.map((row) => [row.id, row.file_name]));
}
