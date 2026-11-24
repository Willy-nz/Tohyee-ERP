import type { Migration } from "@/lib/db/migrations/types";
import { migration as m0001 } from "@/lib/db/migrations/core/0001-core-baseline";
import { migration as m0002 } from "@/lib/db/migrations/core/0002-two-step-sign-in-and-server-settings";
import { migration as m0003 } from "@/lib/db/migrations/core/0003-backup-runs";
import { migration as m0004 } from "@/lib/db/migrations/core/0004-server-starts-and-update-backups";
import { migration as m0005 } from "@/lib/db/migrations/core/0005-ai-access-tokens";
import { migration as m0006 } from "@/lib/db/migrations/core/0006-report-viewer-role";
import { migration as m0007 } from "@/lib/db/migrations/core/0007-consolidation-groups";
import { migration as m0008 } from "@/lib/db/migrations/core/0008-consolidation-commentaries";
import { migration as m0009 } from "@/lib/db/migrations/core/0009-user-setup-links";
import { migration as m0010 } from "@/lib/db/migrations/core/0010-organisation-handovers";
import { migration as m0011 } from "@/lib/db/migrations/core/0011-sign-in-events";
import { migration as m0012 } from "@/lib/db/migrations/core/0012-ai-full-access";
import { migration as m0013 } from "@/lib/db/migrations/core/0013-sales-roles";
import { migration as m0014 } from "@/lib/db/migrations/core/0014-farm-app-keys";
import { migration as m0015 } from "@/lib/db/migrations/core/0015-group-membership-dates";
import { migration as m0016 } from "@/lib/db/migrations/core/0016-backup-evidence";
import { migration as m0017 } from "@/lib/db/migrations/core/0017-google-sign-in";
import { migration as m0018 } from "@/lib/db/migrations/core/0018-ai-connections-oauth";
import { migration as m0019 } from "@/lib/db/migrations/core/0019-office-addin-connections";
import { migration as m0020 } from "@/lib/db/migrations/core/0020-demo-farm";
import { migration as m0021 } from "@/lib/db/migrations/core/0021-remove-older-backup-key-check";
import { migration as m0022 } from "@/lib/db/migrations/core/0022-organisation-invitations";
import { migration as m0025 } from "@/lib/db/migrations/core/0025-passkeys";
import { migration as m0023 } from "@/lib/db/migrations/core/0023-farm-worker-role";
import { migration as m0024 } from "@/lib/db/migrations/core/0024-member-access-window";
import { migration as m0026 } from "@/lib/db/migrations/core/0026-ai-key-end-dates";
import { migration as m0027 } from "@/lib/db/migrations/core/0027-ai-tool-scope";
import { migration as m0028 } from "@/lib/db/migrations/core/0028-ai-key-ending-warned";
import { migration as m0029 } from "@/lib/db/migrations/core/0029-ai-key-addresses";
import { migration as m0030 } from "@/lib/db/migrations/core/0030-consolidation-account-maps";

/**
 * Migrations for the core (control-plane) database named in DATABASE_URL.
 * It holds the organisation registry, users (with their two-step sign-in),
 * sessions, memberships and server settings (email sending, remote access)
 * only.
 * No accounting data ever lives here; that belongs to each organisation's own
 * database (see tenant.ts).
 */
/**
 * Each migration is its own file in ./core/ (decision 1682). This list is
 * the order they run in, which isn't always number order: branches merged at
 * different times. Add a new migration as a new file, then add it to the end
 * of this list. Never edit a released one: tests/unit/migration-files.test.ts
 * checks each against the checksum it was released with.
 */
export const coreMigrations: readonly Migration[] = [
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
  m0008,
  m0009,
  m0010,
  m0011,
  m0012,
  m0013,
  m0014,
  m0015,
  m0016,
  m0017,
  m0018,
  m0019,
  m0020,
  m0021,
  m0022,
  m0025,
  m0023,
  m0024,
  m0026,
  m0027,
  m0028,
  m0029,
  m0030,
];
