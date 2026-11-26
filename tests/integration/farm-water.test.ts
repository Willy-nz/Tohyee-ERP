import { afterAll, beforeAll, expect, it } from "vitest";
import * as waterRoute from "@/app/api/farming/farms/[farmId]/water/route";
import * as pipeRoute from "@/app/api/farming/water-pipes/[assetId]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addMapAsset } from "@/lib/farming/map-assets";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

type Handler = (request: Request, context: never) => Promise<Response>;
const ORG = "farm-water-co";
type Result = { velocity: number; per100M: number; frictionM: number; totalM: number };
type Pipe = { name: string; assetId: string; lengthM: number; insideMm: number | null; flowLpm: number | null; riseM: number | null; result: Result | null };
type Body = { error?: string; pipe: Pipe & { result: Result }; water: { pipes: Pipe[]; totalLengthM: number; counts: Record<string, number> } };

/** Farm water (FW6, not yet reviewed). Made-up farms and people. */
describeWithDatabase("farm water", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  let viewer: SessionUser;
  const w = {} as Record<string, string>;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("water-owner@example.com", { serverAdmin: true, displayName: "Aroha" });
    worker = await createTestUser("water-staff@example.com", { displayName: "Tama" });
    viewer = await createTestUser("water-viewer@example.com", { displayName: "Rangi" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker'), ($1, $3, 'viewer')", [ORG, worker.id, viewer.id]);
    const run = as(owner);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    await run((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
    await run((tx) => setMemberFarmAccess(tx, { userId: viewer.id, role: "viewer", access: "farms", farmIds: [w.home] }));
    w.main = (await run((tx) => addMapAsset(tx, { farmId: w.home, kind: "pipe", name: "Main to the back paddocks", line: [[169.8, -46.18], [169.804, -46.18], [169.804, -46.182]] }))).id;
    w.spur = (await run((tx) => addMapAsset(tx, { farmId: w.home, kind: "pipe", name: "Spur to 14", line: [[169.804, -46.182], [169.806, -46.182]] }))).id;
    w.trough = (await run((tx) => addMapAsset(tx, { farmId: w.home, kind: "trough", name: "Trough in 14", point: [169.806, -46.182] }))).id;
    await run((tx) => addMapAsset(tx, { farmId: w.home, kind: "tank", name: "Header tank", point: [169.8, -46.18] }));
    await run((tx) => addMapAsset(tx, { farmId: w.home, kind: "fence", name: "Boundary", line: [[169.8, -46.18], [169.81, -46.18]] }));
    w.far = (await run((tx) => addMapAsset(tx, { farmId: w.runoff, kind: "pipe", name: "Runoff line", line: [[170, -46], [170.001, -46]] }))).id;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const call = async (user: SessionUser, handler: Handler, url: string, context: Record<string, string>, method = "GET", body?: Record<string, unknown>) => {
    const response = await handler(
      apiRequest(method === "GET" ? `${url}?organisationId=${ORG}` : url, { method, cookie: await sessionCookieFor(user), body: body ? { organisationId: ORG, ...body } : undefined }),
      params(context) as never,
    );
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as Body };
  };
  const water = (user: SessionUser, farmId = w.home) => call(user, waterRoute.GET as Handler, `/api/farming/farms/${farmId}/water`, { farmId });
  const set = (user: SessionUser, assetId: string, figures: Record<string, unknown>) => call(user, pipeRoute.PUT as Handler, `/api/farming/water-pipes/${assetId}`, { assetId }, "PUT", figures);

  it("FW6 lists the farm's mapped pipes with their lengths, and nothing worked out until a pipe has a size and a flow", async () => {
    const seen = await water(viewer);
    expect(seen.status).toBe(200);
    expect(seen.body.water.pipes.map((pipe) => pipe.name)).toEqual(["Main to the back paddocks", "Spur to 14"]);
    const main = seen.body.water.pipes[0];
    expect(main).toMatchObject({ assetId: w.main, insideMm: null, flowLpm: null, riseM: null, result: null });
    // About 309 m east then 222 m south, from the map.
    expect(main.lengthM).toBeGreaterThan(520);
    expect(main.lengthM).toBeLessThan(540);
    expect(seen.body.water.totalLengthM).toBe(main.lengthM + seen.body.water.pipes[1].lengthM);
    expect(seen.body.water.counts).toEqual({ troughs: 1, tanks: 1, bores: 0, waterPoints: 0 });
  });

  it("FW6 farm staff say what a pipe is, and it's worked out from the map's length", async () => {
    const saved = await set(worker, w.main, { insideMm: "40.8", flowLpm: "110", riseM: "12" });
    expect(saved.status).toBe(200);
    const pipe = saved.body.pipe;
    expect(pipe).toMatchObject({ insideMm: 40.8, flowLpm: 110, riseM: 12 });
    expect(pipe.result.velocity).toBe(1.4);
    expect(pipe.result.per100M).toBe(5.28);
    // 5.28 m in each 100 m over the pipe's own length, then the 12 m climb.
    expect(pipe.result.frictionM).toBeCloseTo((5.28 * pipe.lengthM) / 100, 0);
    expect(pipe.result.totalM).toBeCloseTo(pipe.result.frictionM + 12, 5);
    expect((await water(viewer)).body.water.pipes[0].result).toEqual(pipe.result);
    // Just a size: nothing to work out yet. Empty clears a figure.
    const sizeOnly = await set(worker, w.spur, { insideMm: 26.2, flowLpm: "", riseM: null });
    expect(sizeOnly.body.pipe).toMatchObject({ insideMm: 26.2, flowLpm: null, riseM: null, result: null });
    expect((await set(worker, w.main, { insideMm: "40.8", flowLpm: "110", riseM: "" })).body.pipe.riseM).toBeNull();
  });

  it("FW6 refuses what isn't a pipe, what isn't a figure, and people who can't record or see the farm", async () => {
    expect((await set(worker, w.trough, { insideMm: "40.8" })).body.error).toBe("Only a water pipe has a size and a flow.");
    expect((await set(worker, w.main, { insideMm: "wide" })).status).toBe(400);
    expect((await set(worker, w.main, { insideMm: "2" })).body.error).toContain("The inside diameter (mm) is a number from 5 to 1,000.");
    expect((await set(worker, w.main, { insideMm: "40.8", flowLpm: "-5" })).status).toBe(400);
    expect((await set(worker, w.main, { insideMm: "40.8", flowLpm: "110", riseM: "9999" })).status).toBe(400);
    expect((await set(viewer, w.main, { insideMm: "50" })).status).toBe(403);
    // Another farm the worker isn't on.
    expect((await set(worker, w.far, { insideMm: "50" })).status).toBe(404);
    expect((await water(worker, w.runoff)).status).toBe(404);
    expect((await water(owner, w.runoff)).body.water.pipes).toHaveLength(1);
  });
});
