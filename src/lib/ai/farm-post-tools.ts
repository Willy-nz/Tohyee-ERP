import { tool as confirmedTool } from "@/lib/ai/document-action-tools";
import { operationId } from "@/lib/ai/farm-record-tools";
import { MOVEMENT } from "@/lib/ai/farm-tools";
import { type AiTool, DATE, type JsonSchema, schema } from "@/lib/ai/tools";
import { IDEMPOTENCY, idempotencyKey } from "@/lib/ai/write-tools";
import { NotFoundError } from "@/lib/errors";
import { mobAction, mobRow } from "@/lib/farming/mobs";
import { getMovement, recordMovement, voidMovement } from "@/lib/livestock/movements";

/*
 * Farm tools at "Make and post". The owner confirmed the
 * mapping of: "Make drafts" records field work that changes
 * no money; "Make and post" records what the stock records and the books'
 * head count rest on: moving a mob, counting it, births and deaths in it,
 * and livestock movements. Each calls the service its screen calls, so the
 * same rules apply and the record says it came through the AI key.
 *
 * Selling, buying, changing class, splitting and merging came next, and at Full access,
 * after a preview, undoing a mob's event and voiding a livestock movement.
 */

const MOB: JsonSchema = { type: "string", description: "The mob, from list_mobs." };
const ON_DATE: JsonSchema = { ...DATE, description: "The day it happened (YYYY-MM-DD). Default today." };
const NOTE: JsonSchema = { type: "string", maxLength: 500 };

const act = (action: string, fields: (args: Record<string, unknown>) => Record<string, unknown>): AiTool["run"] =>
  async (tx, args, context) => {
    const result = await mobAction(tx, args.mobId, { action, ...fields(args), ...(args.onDate ? { onDate: args.onDate } : {}), note: args.note, operationId: operationId(context, args.idempotencyKey) });
    return { mob: result.mob, livestock: result.livestock, message: result.message };
  };

export const FARM_POST_TOOLS: AiTool[] = [
  {
    name: "move_mob",
    title: "Move a mob",
    description:
      "Moves a mob to another paddock on its farm, as Move does on the mob: it closes the grazing it's in and opens one in the new paddock, and ticks off the planned move if there was one. Leave toPaddockId out to take it out of its paddock. The answer warns if the paddock was sprayed and isn't safe to graze yet: pass that warning on.",
    level: "post",
    inputSchema: schema({ mobId: MOB, toPaddockId: { type: "string", description: "The paddock it's going to, from list_farms_and_paddocks. Leave out to take the mob out of its paddock." }, onDate: ON_DATE, note: NOTE, idempotencyKey: IDEMPOTENCY }, ["mobId"]),
    run: act("move", (args) => ({ toPaddockId: args.toPaddockId ?? null })),
  },
  {
    name: "count_mob",
    title: "Count a mob",
    description:
      "Sets a mob's head to what was counted, as Count does on the mob. A count doesn't change the books' head count: if stock died, was born or sold, record that instead so the books follow. Only record a count someone actually made.",
    level: "post",
    inputSchema: schema({ mobId: MOB, head: { type: "integer", minimum: 0, description: "Head counted." }, onDate: ON_DATE, note: NOTE, idempotencyKey: IDEMPOTENCY }, ["mobId", "head"]),
    run: act("count", (args) => ({ head: args.head })),
  },
  {
    name: "record_mob_births",
    title: "Record births in a mob",
    description:
      "Adds stock born into a mob, as Births does on the mob. With Livestock on, the birth is recorded in the books' head count too (the answer says so). Births go into the youngest classes: for others, the answer says to add a new mob for the young stock.",
    level: "post",
    inputSchema: schema({ mobId: MOB, head: { type: "integer", minimum: 1 }, onDate: ON_DATE, note: NOTE, idempotencyKey: IDEMPOTENCY }, ["mobId", "head"]),
    run: act("births", (args) => ({ head: args.head })),
  },
  {
    name: "record_mob_deaths",
    title: "Record deaths in a mob",
    description:
      "Takes dead stock out of a mob, as Deaths does on the mob. With Livestock on, the deaths are recorded in the books' head count too (the answer says so). If the mob has tagged animals, say which ones died (animalIds, from list_animals) so the register and the head agree; the answer says when that's needed.",
    level: "post",
    inputSchema: schema(
      { mobId: MOB, head: { type: "integer", minimum: 1 }, animalIds: { type: "array", items: { type: "string" }, description: "The tagged animals that died, from list_animals." }, onDate: ON_DATE, note: NOTE, idempotencyKey: IDEMPOTENCY },
      ["mobId", "head"],
    ),
    run: act("deaths", (args) => ({ head: args.head, ...(Array.isArray(args.animalIds) ? { animalIds: args.animalIds } : {}) })),
  },
  {
    name: "sell_from_mob",
    title: "Sell stock from a mob",
    description:
      "Takes sold stock out of a mob, as Sell does on the mob. With Livestock on, the sale is recorded in the books' head count (or linked to a movement already there: movementId, from list_mob_linkable_movements). amount is the sale's value excluding GST, if known. This doesn't make an invoice or record the money: that's the sales tools. If the mob has tagged animals, say which were sold (animalIds). The answer warns if the mob is within a withholding period: pass that on.",
    level: "post",
    inputSchema: schema(
      {
        mobId: MOB,
        head: { type: "integer", minimum: 1 },
        amount: { type: "string", description: "The sale's value excluding GST, as a decimal string." },
        movementId: { type: "string", description: "A livestock movement already recorded for this sale, to link instead of recording another." },
        animalIds: { type: "array", items: { type: "string" }, description: "The tagged animals sold, from list_animals." },
        onDate: ON_DATE,
        note: NOTE,
        idempotencyKey: IDEMPOTENCY,
      },
      ["mobId", "head"],
    ),
    run: act("sell", (args) => ({ head: args.head, amount: args.amount, movementId: args.movementId, ...(Array.isArray(args.animalIds) ? { animalIds: args.animalIds } : {}) })),
  },
  {
    name: "buy_into_mob",
    title: "Add bought stock to a mob",
    description:
      "Adds bought stock to a mob, as Buy does on the mob. With Livestock on, the purchase is recorded in the books' head count (or linked to a movement already there: movementId, from list_mob_linkable_movements). amount is the cost excluding GST, if known. This doesn't make a bill or record the money: that's the purchases tools.",
    level: "post",
    inputSchema: schema(
      {
        mobId: MOB,
        head: { type: "integer", minimum: 1 },
        amount: { type: "string", description: "The cost excluding GST, as a decimal string." },
        movementId: { type: "string", description: "A livestock movement already recorded for this purchase, to link instead of recording another." },
        onDate: ON_DATE,
        note: NOTE,
        idempotencyKey: IDEMPOTENCY,
      },
      ["mobId", "head"],
    ),
    run: act("buy", (args) => ({ head: args.head, amount: args.amount, movementId: args.movementId })),
  },
  {
    name: "change_mob_class",
    title: "Change a mob's class",
    description:
      "Changes the class of a whole mob (for example rising one-year heifers to rising two-year), as Change class does on the mob. With Livestock on, the class change is recorded in the books' head count too. A mob is one class: to change only some, split them off first. Classes come from livestock_overview.",
    level: "post",
    inputSchema: schema({ mobId: MOB, toClassCode: { type: "string", description: "The new class's code, e.g. r2_heifers." }, onDate: ON_DATE, note: NOTE, idempotencyKey: IDEMPOTENCY }, ["mobId", "toClassCode"]),
    run: act("reclass", (args) => ({ toClassCode: args.toClassCode })),
  },
  {
    name: "split_mob",
    title: "Split a mob",
    description:
      "Splits some head off a mob into a new mob of the same kind and class, as Split does on the mob. The new mob goes into toPaddockId, or stays in the same paddock. If the mob has tagged animals, say which go (animalIds). The books' head count isn't changed: the stock is still there.",
    level: "post",
    inputSchema: schema(
      {
        mobId: MOB,
        head: { type: "integer", minimum: 1, description: "How many go into the new mob: some, not all." },
        name: { type: "string", maxLength: 100, description: "The new mob's name." },
        toPaddockId: { type: "string", description: "Where the new mob goes, from list_farms_and_paddocks." },
        tagColour: { type: "string", maxLength: 30 },
        animalIds: { type: "array", items: { type: "string" }, description: "The tagged animals that go, from list_animals." },
        onDate: ON_DATE,
        note: NOTE,
        idempotencyKey: IDEMPOTENCY,
      },
      ["mobId", "head"],
    ),
    run: act("split", (args) => ({ head: args.head, name: args.name, toPaddockId: args.toPaddockId, tagColour: args.tagColour, ...(Array.isArray(args.animalIds) ? { animalIds: args.animalIds } : {}) })),
  },
  {
    name: "merge_mobs",
    title: "Merge a mob into another",
    description:
      "Puts all of a mob into another mob on the same farm, as Merge does on the mob: mobId is closed and intoMobId takes its head and tagged animals. Both must be the same kind and class. The books' head count isn't changed.",
    level: "post",
    inputSchema: schema({ mobId: MOB, intoMobId: { type: "string", description: "The mob it joins, from list_mobs." }, onDate: ON_DATE, note: NOTE, idempotencyKey: IDEMPOTENCY }, ["mobId", "intoMobId"]),
    run: act("merge", (args) => ({ intoMobId: args.intoMobId })),
  },
  {
    name: "record_livestock_movement",
    title: "Record a livestock movement",
    description:
      "Records one movement in the books' livestock head count, as Livestock › Movements does: a birth, purchase, sale, death, rations, missing or found stock, a class change, a move between locations, or stock arriving or leaving that's held for someone else. It's refused when it would take a class below zero on any date, or when that year's valuation is approved. For stock that's in a mob, use the mob's own tools instead so the two stay in step. Purchases and sales here aren't linked to a bill or invoice: a person does that. Unlike suggest_livestock_movements, this records straight away.",
    level: "post",
    inputSchema: schema(
      {
        ...(MOVEMENT.properties as Record<string, JsonSchema>),
        locationId: { type: "string", description: "Where the stock is, from list_livestock_locations, if locations are used." },
        toLocationId: { type: "string", description: "For a transfer: where it moved to." },
        idempotencyKey: IDEMPOTENCY,
      },
      MOVEMENT.required as string[],
    ),
    run: async (tx, args, context) => {
      const { idempotencyKey: key, ...movement } = args;
      const result = await recordMovement(tx, { ...movement, idempotencyKey: idempotencyKey(key), source: context.source });
      return { created: result.created, movement: result.movement };
    },
  },
  confirmedTool({
    name: "undo_mob_event",
    title: "Undo a mob's event",
    description:
      "Reverses a mob's sale, death, birth, purchase or class change, as Reverse does on the mob's history: a new reversed event (history isn't edited) and the event's livestock movement voided, so the books' head count matches. Once at most, with why. If the mob has since moved on (split, merged, changed class or closed), intoMobId says which mob the animals go back into. Events come from get_mob.",
    level: "full",
    input: {
      mobId: MOB,
      eventId: { type: "string", description: "The event to reverse, from get_mob's events." },
      reason: { type: "string", maxLength: 300, description: "Why it's being reversed." },
      intoMobId: { type: "string", description: "Only when the mob has since changed: the mob the animals go back into." },
      onDate: ON_DATE,
    },
    required: ["mobId", "eventId", "reason"],
    shows: async (tx, args) => {
      const mob = await mobRow(tx, args.mobId);
      const found = await tx.query<{ id: string; event_type: string; event_date: string; head_change: number | null }>(
        "select id::text, event_type, event_date::text, head_change from mob_events where id = $1 and mob_id = $2",
        [String(args.eventId), mob.id],
      );
      const event = found.rows[0];
      if (!event) throw new NotFoundError(`That event isn't ${mob.name}'s.`);
      return { id: event.id, reference: `${mob.name}: ${event.event_type}${event.head_change ? `, ${Math.abs(event.head_change)} head` : ""}`, eventDate: event.event_date };
    },
    act: async (tx, args) => {
      const result = await mobAction(tx, args.mobId, { action: "reverse", eventId: args.eventId, reason: args.reason, intoMobId: args.intoMobId, ...(args.onDate ? { onDate: args.onDate } : {}) });
      return { mob: result.mob, livestock: result.livestock, message: result.message };
    },
  }),
  confirmedTool({
    name: "void_livestock_movement",
    title: "Void a livestock movement",
    description:
      "Voids a movement in the books' livestock head count, with why, as Void does on Livestock › Movements. It stays in the list, marked voided. For a movement a mob's event made, use undo_mob_event instead so the mob and the books stay in step.",
    level: "full",
    input: { movementId: { type: "string", description: "The movement, from list_livestock_movements." }, reason: { type: "string", maxLength: 500, description: "Why it's being voided." } },
    required: ["movementId", "reason"],
    shows: async (tx, args) => {
      const movement = await getMovement(tx, args.movementId);
      return { id: movement.id, reference: `${movement.movementType}, ${movement.head} head of ${movement.classCode}`, movementDate: movement.movementDate, status: movement.voided ? "voided" : "recorded" };
    },
    act: async (tx, args) => ({ movement: await voidMovement(tx, args.movementId, { reason: args.reason }) }),
  }),
];
