import { getAlbionClient } from "@aotracker/core/albion/client";
import type { AlbionEvent, AlbionPlayerRef, AlbionRegion } from "@aotracker/core/albion/types";
import { ENABLED_REGIONS, isRegionEnabled } from "@aotracker/core/albion/types";
import { getGuildByAlbionId } from "@aotracker/core/db/queries-ingest";
import { ensureGuildSyncQueued } from "../src/jobs/enqueue";
import { formatFame, regionLabel, toBigInt } from "@aotracker/core/utils";
