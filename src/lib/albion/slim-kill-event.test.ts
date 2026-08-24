import { describe, expect, it } from "vitest";
import type { AlbionEvent } from "./types";
import { slimKillEventPayload } from "./slim-kill-event";

describe("slimKillEventPayload", () => {
  it("drops assist arrays and nested gear on killer/victim", () => {
    const event: AlbionEvent = {
      EventId: 42,
      TimeStamp: "2026-01-01T00:00:00Z",
      TotalVictimKillFame: 1000,
      Killer: {
        Id: "k1",
        Name: "Killer",
        GuildId: "g1",
        Equipment: {
          MainHand: { Type: "T8_MAIN_SWORD", Quality: 4, Count: 1 },
        },
        Inventory: [{ Type: "T8_BAG", Quality: 0, Count: 1 }],
      },
      Victim: {
        Id: "v1",
        Name: "Victim",
        Equipment: {
          MainHand: { Type: "T8_2H_BOW", Quality: 3, Count: 1 },
        },
      },
      GroupMembers: [{ Id: "m1", Name: "Member" }],
      Participants: [{ Id: "p1", Name: "Assist" }],
    };

    const slim = slimKillEventPayload(event);
    expect(slim.GroupMembers).toBeUndefined();
    expect(slim.Participants).toBeUndefined();
    expect(slim.Killer?.Equipment).toBeUndefined();
    expect(slim.Killer?.Inventory).toBeUndefined();
    expect(slim.Killer?.GuildId).toBe("g1");
    expect(slim.Victim?.Equipment).toBeUndefined();
  });
});
