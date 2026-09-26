import { describe, expect, it } from "vitest";
import {
  battleSnapshotObjectKey,
  battleSnapshotPublicUrl,
  snapshotObjectKey,
  snapshotPublicUrl,
} from "./r2";

describe("snapshot R2 keys", () => {
  it("uses a stable kill key (no content digest)", () => {
    expect(snapshotObjectKey("americas", 12345)).toBe(
      "snapshots/americas/12345.png"
    );
    expect(snapshotPublicUrl("americas", 12345)).toBe(
      "https://cdn.aotracker.net/snapshots/americas/12345.png"
    );
  });

  it("scopes battle keys by tracked guild so feeds do not overwrite each other", () => {
    expect(
      battleSnapshotObjectKey("europe", 99, "guild-abc")
    ).toBe("snapshots/europe/battle-99-guild-abc.png");
    expect(
      battleSnapshotPublicUrl("europe", 99, "guild-abc")
    ).toBe(
      "https://cdn.aotracker.net/snapshots/europe/battle-99-guild-abc.png"
    );
  });

  it("sanitizes guild ids for object keys", () => {
    expect(
      battleSnapshotObjectKey("asia", 1, "foo/bar baz")
    ).toBe("snapshots/asia/battle-1-foo_bar_baz.png");
  });
});
