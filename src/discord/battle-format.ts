import {
  ButtonStyle,
  ComponentType,
  type APIButtonComponent,
  type APIEmbed,
} from "discord-api-types/v10";
import { appPublicUrl } from "./enabled";
import type { BattleSnapshot } from "./battle-data";
import { guildInBattle } from "./battle-data";

const COLOR_BATTLE = 0xd4a84b;
const VIEW_BATTLE_LABEL = "View Battle on AOTracker";

export function battlePageUrl(region: string, battleId: number): string {
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
  const tracked = guildInBattle(
    snapshot,
    input.trackedGuildId,
    input.trackedGuildName
  );
  const guildLabel = tracked?.name ?? input.trackedGuildName ?? "Tracked guild";

  const embed: APIEmbed = {
    color: COLOR_BATTLE,
    title: `${guildLabel} battle recap`,
    url: battlePageUrl(snapshot.region, snapshot.albionBattleId),
  };
  if (input.imageUrl) {
    embed.image = { url: input.imageUrl };
  }
  return embed;
}

export function battleLinkButtons(snapshot: BattleSnapshot) {
  const buttons: APIButtonComponent[] = [
    {
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      label: VIEW_BATTLE_LABEL,
      url: battlePageUrl(snapshot.region, snapshot.albionBattleId),
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
