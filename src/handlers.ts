import type { JobPayload } from "./jobs/types";
import {
  BattleNotReadyError,
} from "@aotracker/core/albion/errors";
import { syncBattleDetailData } from "@aotracker/core/albion/battles";
import {
  BATTLE_BELOW_SYNC_THRESHOLD_ERROR,
  battleMeetsDetailSyncThreshold,
  getBattleByAlbionId,
  markBattleDetailUnavailable,
} from "@aotracker/core/db/battle-cache";
import { resolveEntityByName } from "./entity-resolve";
import { runLiveSearch } from "./live-search";
import {
  ensureKillEventInDb,
  refreshAllianceProfile,
  syncGuildProfile,
  syncPlayerProfile,
} from "./ingest";

export async function executeJob(
  name: string,
  payload: JobPayload,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  switch (name) {
    case "ingest-event": {
      if (!payload.region || payload.eventId == null) {
        throw new Error("ingest-event requires region and eventId");
      }
      await ensureKillEventInDb(payload.region, payload.eventId);
      return;
    }
    case "sync-player":
    case "refresh-player":
    case "backfill-player-history": {
      if (!payload.region || !payload.albionId) {
        throw new Error(`${name} requires region and albionId`);
      }
      await syncPlayerProfile(payload.region, payload.albionId);
      return;
    }
    case "sync-guild":
    case "refresh-guild":
    case "backfill-guild-top-kills": {
      if (!payload.region || !payload.guildId) {
        throw new Error(`${name} requires region and guildId`);
      }
      await syncGuildProfile(payload.region, payload.guildId, {
        force: payload.force === true,
      });
      return;
    }
    case "refresh-alliance": {
      if (!payload.region || !payload.allianceId) {
        throw new Error("refresh-alliance requires region and allianceId");
      }
      await refreshAllianceProfile(payload.region, payload.allianceId);
      return;
    }
    case "live-search": {
      if (!payload.searchQuery?.trim()) {
        throw new Error("live-search requires searchQuery");
      }
      return runLiveSearch(payload.searchQuery, payload.searchRegions);
    }
    case "entity-resolve": {
      if (
        !payload.region ||
        !payload.entityType ||
        !payload.entityName?.trim()
      ) {
        throw new Error("entity-resolve requires region, entityType, and entityName");
      }
      const result = await resolveEntityByName(
        payload.region,
        payload.entityType,
        payload.entityName.trim()
      );
      if (!result) {
        throw new Error(
          `No exact ${payload.entityType} match for "${payload.entityName}" in ${payload.region}`
        );
      }
      return result;
    }
    case "sync-battle": {
      if (!payload.region || payload.battleId == null) {
        throw new Error("sync-battle requires region and battleId");
      }
      const existing = await getBattleByAlbionId(payload.region, payload.battleId);
      if (existing?.totalFame != null && existing.detailPayload != null) {
        return;
      }
      if (
        existing &&
        (existing.totalPlayers != null || existing.totalKills != null) &&
        !battleMeetsDetailSyncThreshold(existing)
      ) {
        await markBattleDetailUnavailable(
          payload.region,
          payload.battleId,
          BATTLE_BELOW_SYNC_THRESHOLD_ERROR
        );
        return;
      }
      const result = await syncBattleDetailData(
        payload.region,
        payload.battleId,
        { signal: options?.signal }
      );
      if (!result) {
        throw new BattleNotReadyError(payload.region, payload.battleId);
      }
      const cached = await getBattleByAlbionId(payload.region, payload.battleId);
      if (
        cached &&
        (cached.totalPlayers != null || cached.totalKills != null) &&
        !battleMeetsDetailSyncThreshold(cached)
      ) {
        await markBattleDetailUnavailable(
          payload.region,
          payload.battleId,
          BATTLE_BELOW_SYNC_THRESHOLD_ERROR
        );
        return;
      }
      if (cached?.totalFame == null || cached.detailPayload == null) {
        throw new Error(
          `Battle detail failed to persist (${payload.region}/${payload.battleId})`
        );
      }
      try {
        const { emitBattleIngested } = await import("./discord/dispatcher");
        const { snapshotFromAlbionBattle } = await import("./discord/battle-data");
        const detail = cached.detailPayload as { guilds?: unknown } | null;
        const raw = cached.rawPayload as {
          guilds?: unknown;
          startTime?: string;
          endTime?: string;
        } | null;
        await emitBattleIngested(
          payload.region,
          payload.battleId,
          snapshotFromAlbionBattle(payload.region, payload.battleId, {
            startTime: cached.startTime,
            endTime: cached.endTime,
            totalPlayers: cached.totalPlayers,
            totalKills: cached.totalKills,
            totalFame: cached.totalFame,
            guilds: detail?.guilds ?? raw?.guilds,
          })
        );
      } catch (err) {
        console.error(
          `[ingest] Failed to enqueue discord battle notify for ${payload.region}/${payload.battleId}:`,
          err
        );
      }
      return;
    }
    case "notify-discord": {
      const { handleNotifyDiscord } = await import("./discord/notify");
      await handleNotifyDiscord(payload);
      return;
    }
    case "notify-discord-live": {
      const { handleNotifyDiscordLive } = await import("./discord/notify-live");
      await handleNotifyDiscordLive(payload);
      return;
    }
    default:
      throw new Error(`Unknown job: ${name}`);
  }
}
