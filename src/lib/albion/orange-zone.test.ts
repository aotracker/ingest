import { describe, expect, it } from "vitest";
import {
  computeRawItemPower,
  MASTERY_BONUS_OFFSET,
  parseEquippedItemPower,
} from "./item-power";
import {
  fameLooksInventoryOnly,
  isOrangeZoneKill,
  LETHAL_ANCIENT_LANDS_SOFTCAP_RATE,
  ORANGE_SOFTCAP,
  ORANGE_SOFTCAP_RATE,
  playerSoftcapMatch,
  playerSoftcapRate,
} from "./orange-zone";
import type { AlbionEquipment, AlbionItem, AlbionPlayerRef } from "./types";

function item(type: string, quality = 1): AlbionItem {
  return { Type: type, Quality: quality, Count: 1 };
}

/** T8.3 masterpiece 2H set — well above the 1200 cap. */
function overcappedSet(): AlbionEquipment {
  return {
    MainHand: item("T8_2H_BOW@3", 5),
    Head: item("T8_HEAD_PLATE_SET1@3", 5),
    Armor: item("T8_ARMOR_PLATE_SET1@3", 5),
    Shoes: item("T8_SHOES_PLATE_SET1@3", 5),
    Cape: item("T8_CAPE@3", 5),
  };
}

function t6CombatSet(): AlbionEquipment {
  return {
    MainHand: item("T6_2H_BOW"),
    Armor: item("T6_ARMOR_PLATE_SET1"),
    Head: item("T6_HEAD_PLATE_SET1"),
    Shoes: item("T6_SHOES_PLATE_SET1"),
    Cape: item("T6_CAPE"),
  };
}

function expectedCapped(raw: number, rate: number): number {
  return ORANGE_SOFTCAP + (raw - ORANGE_SOFTCAP) * rate;
}

describe("parseEquippedItemPower", () => {
  it("adds enchant and quality on top of catalog base IP", () => {
    // T8 bow base 1100 + 3*100 enchant + 100 masterpiece
    expect(parseEquippedItemPower(item("T8_2H_BOW@3", 5))).toBe(1500);
  });
});

describe("computeRawItemPower", () => {
  it("averages six combat slots and adds the mastery offset", () => {
    const raw = computeRawItemPower(overcappedSet());
    expect(raw).toBeCloseTo(1500 + MASTERY_BONUS_OFFSET, 5);
  });
});

describe("playerSoftcapRate", () => {
  it("detects the 1200 / 20% orange curve", () => {
    const raw = computeRawItemPower(overcappedSet())!;
    const player: AlbionPlayerRef = {
      AverageItemPower: expectedCapped(raw, ORANGE_SOFTCAP_RATE),
      Equipment: overcappedSet(),
    };
    expect(playerSoftcapRate(player)).toBe(ORANGE_SOFTCAP_RATE);
  });

  it("detects the 1200 / 35% lethal Ancient Lands curve", () => {
    const raw = computeRawItemPower(overcappedSet())!;
    const player: AlbionPlayerRef = {
      AverageItemPower: expectedCapped(raw, LETHAL_ANCIENT_LANDS_SOFTCAP_RATE),
      Equipment: overcappedSet(),
    };
    expect(playerSoftcapRate(player)).toBe(LETHAL_ANCIENT_LANDS_SOFTCAP_RATE);
  });

  it("does not match uncompressed IP near raw", () => {
    const raw = computeRawItemPower(overcappedSet())!;
    const player: AlbionPlayerRef = {
      AverageItemPower: raw,
      Equipment: overcappedSet(),
    };
    expect(playerSoftcapRate(player)).toBeNull();
  });
});

describe("isOrangeZoneKill", () => {
  it("labels 1200/20% compression as orange at any party size", () => {
    const raw = computeRawItemPower(overcappedSet())!;
    const ip = expectedCapped(raw, ORANGE_SOFTCAP_RATE);
    const loadout: AlbionPlayerRef = {
      AverageItemPower: ip,
      Equipment: overcappedSet(),
    };
    const input = {
      totalVictimKillFame: 80_000,
      gearEstSilver: 8_000_000,
      lootEstSilver: 25_000_000,
      killer: loadout,
      victim: { ...loadout },
    };
    expect(isOrangeZoneKill(input)).toBe(true);
    expect(
      isOrangeZoneKill({
        ...input,
        participants: Array.from({ length: 20 }, () => ({ ...loadout })),
      })
    ).toBe(true);
  });

  it("does not label 1200/35% compression as orange", () => {
    const raw = computeRawItemPower(overcappedSet())!;
    const ip = expectedCapped(raw, LETHAL_ANCIENT_LANDS_SOFTCAP_RATE);
    const loadout: AlbionPlayerRef = {
      AverageItemPower: ip,
      Equipment: overcappedSet(),
    };
    expect(
      isOrangeZoneKill({
        totalVictimKillFame: 200_000,
        gearEstSilver: 8_000_000,
        killer: loadout,
        victim: { ...loadout },
      })
    ).toBe(false);
  });

  it("does not let an overlapping 35% reading veto a clear 20% match", () => {
    const raw = computeRawItemPower(overcappedSet())!;
    const orangeIp = expectedCapped(raw, ORANGE_SOFTCAP_RATE);
    const lethalIp = expectedCapped(raw, LETHAL_ANCIENT_LANDS_SOFTCAP_RATE);
    const victim: AlbionPlayerRef = {
      AverageItemPower: orangeIp,
      Equipment: overcappedSet(),
    };
    const killer: AlbionPlayerRef = {
      AverageItemPower: (orangeIp + lethalIp) / 2,
      Equipment: overcappedSet(),
    };
    expect(playerSoftcapMatch(victim)).toEqual({ orange: true, lethal: false });
    expect(playerSoftcapMatch(killer)).toEqual({ orange: true, lethal: true });
    expect(
      isOrangeZoneKill({
        totalVictimKillFame: 80_000,
        gearEstSilver: 8_000_000,
        lootEstSilver: 25_000_000,
        killer,
        victim,
      })
    ).toBe(true);
  });

  it("labels inventory-only fame as orange even when IP is closer to 35%", () => {
    const raw = computeRawItemPower(overcappedSet())!;
    const loadout: AlbionPlayerRef = {
      AverageItemPower: expectedCapped(raw, LETHAL_ANCIENT_LANDS_SOFTCAP_RATE),
      Equipment: overcappedSet(),
    };
    expect(
      isOrangeZoneKill({
        totalVictimKillFame: 1152,
        gearEstSilver: 47_000_000,
        lootEstSilver: 18_000,
        killer: loadout,
        victim: { ...loadout },
      })
    ).toBe(true);
  });

  it("does not treat a 35% empty-bag combat death as orange", () => {
    const raw = computeRawItemPower(overcappedSet())!;
    const loadout: AlbionPlayerRef = {
      AverageItemPower: expectedCapped(raw, LETHAL_ANCIENT_LANDS_SOFTCAP_RATE),
      Equipment: overcappedSet(),
    };
    expect(
      isOrangeZoneKill({
        totalVictimKillFame: 0,
        gearEstSilver: 8_000_000,
        lootEstSilver: 0,
        killer: loadout,
        victim: { ...loadout },
      })
    ).toBe(false);
  });

  it("uses fame-vs-gear for an empty-bag combat death", () => {
    expect(
      isOrangeZoneKill({
        totalVictimKillFame: 0,
        gearEstSilver: 2_000_000,
        lootEstSilver: 0,
        victim: { Equipment: t6CombatSet(), AverageItemPower: 1100 },
      })
    ).toBe(true);
  });

  it("does not treat a gatherer loot piñata as orange", () => {
    expect(
      isOrangeZoneKill({
        totalVictimKillFame: 40_000,
        gearEstSilver: 80_000,
        lootEstSilver: 25_000_000,
        victim: {
          AverageItemPower: 800,
          Equipment: {
            MainHand: item("T4_2H_TOOL_TRACKING"),
            Head: item("T4_HEAD_CLOTH_SET1"),
          },
        },
      })
    ).toBe(false);
  });

  it("does not label uncompressed reported IP as orange", () => {
    const raw = computeRawItemPower(overcappedSet())!;
    const loadout: AlbionPlayerRef = {
      AverageItemPower: raw,
      Equipment: overcappedSet(),
    };
    expect(
      isOrangeZoneKill({
        totalVictimKillFame: 200_000,
        gearEstSilver: 8_000_000,
        killer: loadout,
        victim: { ...loadout },
      })
    ).toBe(false);
  });

  it("does not treat lethal fame that includes gear as orange", () => {
    expect(
      fameLooksInventoryOnly({
        totalVictimKillFame: 120_000,
        gearEstSilver: 8_000_000,
        lootEstSilver: 500_000,
        victim: { Equipment: t6CombatSet() },
      })
    ).toBe(false);
  });
});
