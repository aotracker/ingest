import {
  ButtonStyle,
  ComponentType,
  type APIButtonComponent,
  type APIEmbed,
} from "discord-api-types/v10";
import { appPublicUrl } from "./enabled";
import { formatFame, formatUtcStamp, regionLabel } from "./format";
import type { BattleSnapshot } from "./battle-data";
import { guildInBattle } from "./battle-data";

const COLOR_BATTLE = 0xd4a84b;

export function battlePageUrl(
  region: string,
  battleId: number,
  preview = false
): string {
  if (preview || battleId <= 0) {
    return `${appPublicUrl()}/battles?region=${encodeURIComponent(region)}`;
  }
  return `${appPublicUrl()}/battle/${region}/${battleId}`;
}

export function buildBattleEmbed(input: {
  snapshot: BattleSnapshot;
  trackedGuildId: string;
  trackedGuildName?: string | null;
  preview?: boolean;
  imageUrl?: string;
}): APIEmbed {
  const { snapshot } = input;
  const preview = Boolean(input.preview);
  const tracked = guildInBattle(
    snapshot,
    input.trackedGuildId,
    input.trackedGuildName
  );
  const url = battlePageUrl(snapshot.region, snapshot.albionBattleId, preview);
  const guildLabel = tracked?.name ?? input.trackedGuildName ?? "Tracked guild";
  const when = snapshot.startTime
    ? formatUtcStamp(snapshot.startTime)
    : "Unknown time";

  const description = [
    preview ? "**Preview** — sample recap, not a real fight." : null,
    `${regionLabel(snapshot.region)} · ${when}`,
    `${snapshot.totalPlayers.toLocaleString()} players · ${snapshot.totalKills.toLocaleString()} kills · ${formatFame(snapshot.totalFame)} fame`,
    tracked
      ? `**${tracked.name}**  ${tracked.kills}/${tracked.deaths}  ${formatFame(tracked.killFame)} fame${tracked.players > 0 ? `  ${tracked.players} players` : ""}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const embed: APIEmbed = {
    color: COLOR_BATTLE,
    title: preview ? `${guildLabel} battle recap` : `${guildLabel} battle recap`,
    url,
    description,
    footer: {
      text: preview
        ? "AOTracker · preview (not a live battle)"
        : "AOTracker · battle recap",
    },
  };
  if (input.imageUrl) {
    embed.image = { url: input.imageUrl };
  }
  return embed;
}

export function battleLinkButtons(
  snapshot: BattleSnapshot,
  preview = false
) {
  const buttons: APIButtonComponent[] = [
    {
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      label: preview ? "Battles on AOTracker" : "Battle page",
      url: battlePageUrl(snapshot.region, snapshot.albionBattleId, preview),
    },
  ];
  return [{ type: ComponentType.ActionRow, components: buttons }];
}

export function battleThreadName(
  snapshot: BattleSnapshot,
  trackedGuildName?: string | null
): string {
  const guild = trackedGuildName?.trim() || "Battle";
  const raw = `${guild} · ${snapshot.totalPlayers}p · #${snapshot.albionBattleId}`;
  return raw.slice(0, 100);
}
