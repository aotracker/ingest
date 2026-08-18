import { describe, expect, it } from "vitest";
import {
  eventOccurredMs,
  sortEventsOldestFirst,
  uniqueEventsById,
} from "./order";

describe("sortEventsOldestFirst", () => {
  it("orders by timestamp oldest to newest", () => {
    const ordered = sortEventsOldestFirst([
      { EventId: 3, TimeStamp: "2026-08-18T12:00:03.000Z" },
      { EventId: 1, TimeStamp: "2026-08-18T12:00:01.000Z" },
      { EventId: 2, TimeStamp: "2026-08-18T12:00:02.000Z" },
    ]);
    expect(ordered.map((event) => event.EventId)).toEqual([1, 2, 3]);
  });

  it("breaks timestamp ties with EventId", () => {
    const stamp = "2026-08-18T12:00:00.000Z";
    const ordered = sortEventsOldestFirst([
      { EventId: 20, TimeStamp: stamp },
      { EventId: 10, TimeStamp: stamp },
    ]);
    expect(ordered.map((event) => event.EventId)).toEqual([10, 20]);
  });

  it("does not mutate the input", () => {
    const events = [
      { EventId: 2, TimeStamp: "2026-08-18T12:00:02.000Z" },
      { EventId: 1, TimeStamp: "2026-08-18T12:00:01.000Z" },
    ];
    sortEventsOldestFirst(events);
    expect(events[0]?.EventId).toBe(2);
  });
});

describe("uniqueEventsById", () => {
  it("keeps the last copy of a duplicate EventId", () => {
    const unique = uniqueEventsById([
      { EventId: 1, TimeStamp: "a" },
      { EventId: 2, TimeStamp: "b" },
      { EventId: 1, TimeStamp: "c" },
    ]);
    expect(unique).toEqual([
      { EventId: 1, TimeStamp: "c" },
      { EventId: 2, TimeStamp: "b" },
    ]);
  });
});

describe("eventOccurredMs", () => {
  it("parses valid timestamps", () => {
    expect(eventOccurredMs({ TimeStamp: "2026-08-18T12:00:00.000Z" })).toBe(
      Date.parse("2026-08-18T12:00:00.000Z")
    );
  });

  it("sorts invalid timestamps last", () => {
    expect(eventOccurredMs({ TimeStamp: "not-a-date" })).toBe(
      Number.POSITIVE_INFINITY
    );
  });
});
