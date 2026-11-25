import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { getOrganisation } from "@/lib/organisations/registry";
import { createTestOrganisation, createTestUser, describeWithDatabase, startTestServer, type TestServer } from "../helpers/test-server";

/** SPF12 (review L7): the Analytics copy of the books reads every table from one point in time. */
describeWithDatabase("SPF12: one point in time for the books copy", () => {
  let server: TestServer;
  let owner: SessionUser;
  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("snapshot@example.test", { serverAdmin: true, displayName: "S" });
  });
  afterAll(async () => server?.teardown());

  it("a snapshot transaction is repeatable read, and a read-only one stays read-only", async () => {
    await createTestOrganisation(owner, "snapshot-co");
    const organisation = (await getOrganisation("snapshot-co"))!;
    const actor = { userId: owner.id, email: owner.email };
    const seen = await withOrganisationTransaction(
      organisation,
      actor,
      async (tx) => ({
        isolation: (await tx.query<{ transaction_isolation: string }>("show transaction_isolation")).rows[0].transaction_isolation,
        readOnly: (await tx.query<{ transaction_read_only: string }>("show transaction_read_only")).rows[0].transaction_read_only,
      }),
      { readOnly: true, snapshot: true },
    );
    expect(seen).toEqual({ isolation: "repeatable read", readOnly: "on" });
  });
});
