import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { describeWithDatabase, startTestServer, testDatabaseUrl, type TestServer, withDb } from "../helpers/test-server";

const BEA = "00000000-0000-4000-8000-0000000000b1";
const BEN = "00000000-0000-4000-8000-0000000000b2";

/** The team chat becomes Everyone, keeping its messages and who has read what (TCH11; details following common practice, not yet reviewed). */
describeWithDatabase("chat upgrade", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server?.teardown();
  });

  it("TCH11: Everyone keeps the team chat's messages, photos and unread state", async () => {
    const migration = tenantMigrations.find((entry) => entry.version === "0320")!;
    expect(migration.name).toBe("chat_spaces");
    expect(tenantMigrations.filter((entry) => entry.version === "0320")).toHaveLength(1);
    const database = `${server.coreDatabase}_org_chat_upgrade`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${database}"`);
    await admin.end();
    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, database) });
    await client.connect();
    try {
      await applyMigrations(client, tenantMigrations.filter((entry) => entry.version < "0320"), "chat-upgrade");
      await client.query(
        `insert into farms (name, created_by_email) values ('Home farm', 'ben@example.com');
         insert into farm_chat_messages (farm_id, body, posted_by_user_id, posted_by_email) values (null, 'Courier at 2', '${BEN}', 'ben@example.com');
         insert into farm_chat_messages (farm_id, body, posted_by_user_id, posted_by_email) values ((select id from farms), 'Gate is open', '${BEN}', 'ben@example.com');
         insert into farm_chat_messages (farm_id, body, posted_by_user_id, posted_by_email) values (null, 'Got it', '${BEA}', 'bea@example.com');
         insert into farm_chat_messages (farm_id, body, posted_by_user_id, posted_by_email) values (null, 'Two more boxes', '${BEN}', 'ben@example.com');
         insert into farm_chat_messages (farm_id, body, posted_by_user_id, posted_by_email) values (null, 'And a pallet', '${BEN}', 'ben@example.com');
         insert into farm_chat_attachments (message_id, kind, file_name, content_type, bytes, content)
           values ((select id from farm_chat_messages where body = 'Courier at 2'), 'photo', 'box.png', 'image/png', 1, '\\x00');
         insert into team_chat_reads (user_id, read_up_to) values ('${BEA}', (select id from farm_chat_messages where body = 'Got it'));`,
      );
      const unread = `select count(*)::int as n from farm_chat_messages m where m.removed_at is null and m.posted_by_user_id is distinct from $1 and m.id > $2::bigint`;
      const read = (await client.query<{ read_up_to: string }>("select read_up_to::text from team_chat_reads where user_id = $1", [BEA])).rows[0].read_up_to;
      const beforeCount = (await client.query<{ n: number }>(`${unread} and m.farm_id is null`, [BEA, read])).rows[0].n;
      expect(beforeCount).toBe(2);

      await applyMigrations(client, tenantMigrations, "chat-upgrade");

      const rooms = (await client.query<{ id: string; kind: string; name: string }>("select id::text, kind, name from chat_rooms")).rows;
      expect(rooms.map((room) => [room.kind, room.name])).toEqual([["everyone", "Everyone"]]);
      const everyone = rooms[0].id;
      expect(everyone).toMatch(/^[0-9a-f-]{36}$/);
      const placed = (await client.query<{ body: string; room_id: string | null; farm_id: string | null }>("select body, room_id::text, farm_id::text from farm_chat_messages order by id")).rows;
      expect(placed.map((row) => [row.body, row.room_id === everyone, row.farm_id !== null])).toEqual([
        ["Courier at 2", true, false],
        ["Gate is open", false, true],
        ["Got it", true, false],
        ["Two more boxes", true, false],
        ["And a pallet", true, false],
      ]);
      expect((await client.query("select count(*)::int as n from farm_chat_attachments")).rows[0].n).toBe(1);
      const moved = (await client.query<{ read_up_to: string }>("select read_up_to::text from chat_room_reads where user_id = $1 and room_id = $2", [BEA, everyone])).rows[0];
      expect(moved.read_up_to).toBe(read);
      const afterCount = (await client.query<{ n: number }>(`${unread} and m.room_id = $3`, [BEA, moved.read_up_to, everyone])).rows[0].n;
      expect(afterCount).toBe(2);
      expect((await client.query("select to_regclass('team_chat_reads') as t")).rows[0].t).toBeNull();
      // A message is in a farm's chat or a room, never both or neither.
      await expect(client.query(`insert into farm_chat_messages (farm_id, room_id, body, posted_by_email) values ((select id from farms), '${everyone}', 'x', 'a@example.com')`)).rejects.toThrow();
      await expect(client.query("insert into farm_chat_messages (farm_id, room_id, body, posted_by_email) values (null, null, 'x', 'a@example.com')")).rejects.toThrow();
      // There's only ever one Everyone.
      await expect(client.query("insert into chat_rooms (kind, name) values ('everyone', 'Everyone')")).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
});
