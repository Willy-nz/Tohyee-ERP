import { describe, expect, it } from "vitest";
import { roleCeiling } from "@/lib/ai/access-levels";
import { FARM_STAFF_READ_TOOLS, FARM_STAFF_RECORD_TOOLS, farmStaffAllows, roleMayUseAi } from "@/lib/ai/farm-staff";
import { FARMING_TOOLS } from "@/lib/ai/tool-modules";
import { AI_TOOL_PLAIN_WORDS } from "@/lib/ai/tool-names";
import { ROLES } from "@/lib/auth/roles";

const levelOf = (name: string) => AI_TOOL_PLAIN_WORDS.find((tool) => tool.name === name)?.level;

describe("what farm staff's AI can use", () => {
  it("is only real farm tools: the read ones look, the record ones are Make drafts", () => {
    for (const name of FARM_STAFF_READ_TOOLS) expect(levelOf(name), name).toBe("read");
    for (const name of FARM_STAFF_RECORD_TOOLS) expect(levelOf(name), name).toBe("draft");
    for (const name of [...FARM_STAFF_READ_TOOLS, ...FARM_STAFF_RECORD_TOOLS]) expect(FARMING_TOOLS, name).toContain(name);
  });

  it("leaves out anything with the farm's money, the organisation or the books", () => {
    for (const name of ["farm_home", "farm_benchmarks", "livestock_overview", "list_fertiliser_plans", "get_fertiliser_plan", "list_staff", "get_organisation", "profit_and_loss", "farm_notebook", "save_dataset"]) {
      expect(farmStaffAllows(name, "draft"), name).toBe(false);
    }
    expect(farmStaffAllows("record_grazing", "draft")).toBe(true);
    expect(farmStaffAllows("record_grazing", "read")).toBe(false);
    expect(farmStaffAllows("list_grazings", "read")).toBe(true);
  });

  it("farm staff may have an AI at Make drafts at most; the CRM-only and report-only roles may not have one", () => {
    expect(ROLES.filter((role) => roleMayUseAi(role))).toEqual(["farm_worker", "viewer", "bookkeeper", "admin", "owner"]);
    expect(roleCeiling("farm_worker")).toBe("draft");
    expect(roleCeiling("viewer")).toBe("read");
  });
});
