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
import {
  ensureKillEventInDb,
  refreshAllianceProfile,
  syncGuildProfile,
  syncPlayerProfile,
} from "./ingest";

export async function executeJob(name: string, payload: JobPayload): Promise<void> {
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
      const result = await syncBattleDetailData(payload.region, payload.battleId);
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
      return;
    }
    default:
      throw new Error(`Unknown job: ${name}`);
  }
}
