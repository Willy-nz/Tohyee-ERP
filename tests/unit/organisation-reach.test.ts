import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addressPlace, assertOrganisationMayReach, setOrganisationReachForTests } from "@/lib/network/organisation-reach";

/**
 * Where an organisation's own settings (database sources, a post box) may make
 * the server connect. Without the server's database the defaults apply:
 * the local network yes, this computer no. Addresses are made up.
 */
describe("connections from organisations' settings", () => {
  const own = ["192.168.1.5", "fe80::1"];
  beforeAll(() =>
    setOrganisationReachForTests({
      resolve: async (host) => ({ "accounts-server": ["192.168.1.20"], "sneaky.example": ["203.0.113.8", "127.0.0.1"], "public-db.example": ["203.0.113.9"] })[host] ?? [],
      ownAddresses: () => own,
    }),
  );
  afterAll(() => setOrganisationReachForTests({ resolve: null, ownAddresses: null }));

  it("tells this computer, the local network and the internet apart", () => {
    expect(addressPlace("127.0.0.1", own)).toBe("this_computer");
    expect(addressPlace("::1", own)).toBe("this_computer");
    expect(addressPlace("::ffff:127.0.0.1", own)).toBe("this_computer");
    expect(addressPlace("169.254.169.254", own)).toBe("this_computer");
    expect(addressPlace("0.0.0.0", own)).toBe("this_computer");
    expect(addressPlace("192.168.1.5", own)).toBe("this_computer");
    expect(addressPlace("192.168.1.20", own)).toBe("local_network");
    expect(addressPlace("10.0.0.5", own)).toBe("local_network");
    expect(addressPlace("203.0.113.9", own)).toBe("internet");
  });

  it("by default allows the internet and the local network, and refuses this computer, checking every address a name gives", async () => {
    await expect(assertOrganisationMayReach("public-db.example", "a database source")).resolves.toEqual(["203.0.113.9"]);
    await expect(assertOrganisationMayReach("accounts-server", "a database source")).resolves.toEqual(["192.168.1.20"]);
    await expect(assertOrganisationMayReach("localhost-by-ip", "a database source")).rejects.toThrow(/couldn't find a server/);
    await expect(assertOrganisationMayReach("127.0.0.1", "a database source")).rejects.toThrow(/this Tohyee server itself/);
    await expect(assertOrganisationMayReach("192.168.1.5", "a database source")).rejects.toThrow(/this Tohyee server itself/);
    await expect(assertOrganisationMayReach("sneaky.example", "a database source")).rejects.toThrow(/this Tohyee server itself/);
  });
});
