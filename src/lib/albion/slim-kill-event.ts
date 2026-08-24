import type { AlbionEvent, AlbionPlayerRef } from "./types";

function slimPlayerRef(ref: AlbionPlayerRef): AlbionPlayerRef {
  const { Equipment: _equipment, Inventory: _inventory, ...rest } = ref;
  return rest;
}

/** Store kill-time identity without duplicating gear already in kill_items / kill_participants. */
export function slimKillEventPayload(event: AlbionEvent): AlbionEvent {
  const {
    GroupMembers: _groupMembers,
    Participants: _participants,
    ...rest
  } = event;
  return {
    ...rest,
    Killer: event.Killer ? slimPlayerRef(event.Killer) : event.Killer,
    Victim: event.Victim ? slimPlayerRef(event.Victim) : event.Victim,
  };
}
