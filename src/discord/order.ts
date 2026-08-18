import type { AlbionEvent } from "@aotracker/core/albion/types";

type TimedEvent = Pick<AlbionEvent, "EventId" | "TimeStamp">;

export function eventOccurredMs(event: Pick<AlbionEvent, "TimeStamp">): number {
  const ms = Date.parse(event.TimeStamp);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Albion event feeds are newest-first; Discord posts should be oldest-first. */
export function sortEventsOldestFirst<T extends TimedEvent>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const dt = eventOccurredMs(a) - eventOccurredMs(b);
    if (dt !== 0) return dt;
    return a.EventId - b.EventId;
  });
}

export function uniqueEventsById<T extends Pick<AlbionEvent, "EventId">>(
  events: T[]
): T[] {
  const byId = new Map<number, T>();
  for (const event of events) {
    if (event?.EventId) byId.set(event.EventId, event);
  }
  return [...byId.values()];
}
