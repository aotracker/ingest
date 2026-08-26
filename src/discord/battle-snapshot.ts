import sharp from "sharp";
import {
  formatFame,
  formatItemPower,
  formatUtcStampShort,
  regionLabel,
} from "./format";
import {
  battleScoreboardRows,
  guildInBattle,
  type BattleGuildScore,
  type BattleSnapshot,
} from "./battle-data";

const WIDTH = 1200;
const HEIGHT = 630;
const SITE_NAME = "AOTracker";

const COLOR = {
  kill: "#3dd68c",
  death: "#e85d5d",
  fame: "#f5c14a",
  ip: "#38bdf8",
  muted: "#7d8b9a",
  text: "#d7e0ea",
  border: "#2a3441",
  highlight: "#f5c14a",
  fg: "#e8edf2",
} as const;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function svgText(
  text: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  extra = ""
): string {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-family="Arial, Helvetica, sans-serif" ${extra}>${escapeXml(text)}</text>`;
}

export function battleImageSubtitle(snapshot: BattleSnapshot): string {
  const when = snapshot.startTime
    ? formatUtcStampShort(snapshot.startTime)
    : null;
  return [
    regionLabel(snapshot.region),
    when,
    `${formatFame(snapshot.totalFame)} fame`,
    `${snapshot.totalKills.toLocaleString()} kills`,
    `${snapshot.totalPlayers.toLocaleString()} players`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function cell(
  guild: BattleGuildScore,
  y: number,
  highlight: boolean
): string {
  const nameFill = highlight ? COLOR.highlight : COLOR.text;
  const rowBg = highlight
    ? `<rect x="84" y="${y - 28}" width="1032" height="48" rx="8" fill="rgba(245,193,74,0.12)"/>`
    : "";
  return `
    ${rowBg}
    ${svgText(truncate(guild.name, 16), 100, y, 22, nameFill, 'font-weight="600"')}
    ${svgText(truncate(guild.alliance?.trim() || "—", 16), 330, y, 20, COLOR.muted)}
    ${svgText((guild.players > 0 ? guild.players : 0).toLocaleString(), 560, y, 22, COLOR.text, 'text-anchor="end" font-weight="600"')}
    ${svgText(guild.kills.toLocaleString(), 680, y, 22, COLOR.kill, 'text-anchor="end" font-weight="600"')}
    ${svgText(guild.deaths.toLocaleString(), 800, y, 22, COLOR.death, 'text-anchor="end" font-weight="600"')}
    ${svgText(formatItemPower(guild.averageIp), 920, y, 22, COLOR.ip, 'text-anchor="end" font-weight="600"')}
    ${svgText(formatFame(guild.killFame), 1090, y, 22, COLOR.fame, 'text-anchor="end" font-weight="600"')}
  `;
}

export async function renderBattleSnapshotPng(input: {
  snapshot: BattleSnapshot;
  trackedGuildId: string;
  trackedGuildName?: string | null;
  preview?: boolean;
}): Promise<Buffer> {
  const { snapshot } = input;
  const tracked = guildInBattle(
    snapshot,
    input.trackedGuildId,
    input.trackedGuildName
  );
  const rows = battleScoreboardRows(
    snapshot,
    input.trackedGuildId,
    input.trackedGuildName
  );
  const title =
    snapshot.albionBattleId > 0
      ? `Albion Battle #${snapshot.albionBattleId}`
      : `${tracked?.name ?? input.trackedGuildName ?? "Guild"} recap`;
  const subtitle = input.preview
    ? `Preview · ${battleImageSubtitle(snapshot)}`
    : battleImageSubtitle(snapshot);
  const badge = input.preview ? "Preview" : "Albion Battle";
  const headerY = 118;
  const tableY = 310;
  const rowStart = 410;

  const rowSvg = rows
    .map((guild, index) =>
      cell(
        guild,
        rowStart + index * 48,
        Boolean(
          tracked &&
            (guild.id === tracked.id || guild.name === tracked.name)
        )
      )
    )
    .join("");

  const svg = Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0c0f14"/>
          <stop offset="55%" stop-color="#151a22"/>
          <stop offset="100%" stop-color="#1a2330"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)"/>
      ${svgText(SITE_NAME, 56, 78, 26, COLOR.fg, 'font-weight="700"')}
      <rect x="980" y="50" width="164" height="40" rx="20" fill="none" stroke="${COLOR.border}"/>
      ${svgText(badge, 1062, 76, 18, COLOR.muted, 'text-anchor="middle"')}
      ${svgText(title, 56, headerY + 40, 44, COLOR.fg, 'font-weight="700"')}
      ${svgText(subtitle, 56, headerY + 78, 22, COLOR.muted)}
      <rect x="56" y="${tableY}" width="1088" height="${Math.max(220, 70 + rows.length * 48)}" rx="16" fill="rgba(12,15,20,0.55)" stroke="${COLOR.border}"/>
      ${svgText("Guilds", 84, tableY + 36, 22, COLOR.fg, 'font-weight="700"')}
      ${svgText("GUILD", 100, tableY + 70, 14, COLOR.muted, 'font-weight="600"')}
      ${svgText("ALLIANCE", 330, tableY + 70, 14, COLOR.muted, 'font-weight="600"')}
      ${svgText("PLAYERS", 560, tableY + 70, 14, COLOR.muted, 'text-anchor="end" font-weight="600"')}
      ${svgText("KILLS", 680, tableY + 70, 14, COLOR.kill, 'text-anchor="end" font-weight="600"')}
      ${svgText("DEATHS", 800, tableY + 70, 14, COLOR.death, 'text-anchor="end" font-weight="600"')}
      ${svgText("AVG IP", 920, tableY + 70, 14, COLOR.ip, 'text-anchor="end" font-weight="600"')}
      ${svgText("FAME", 1090, tableY + 70, 14, COLOR.fame, 'text-anchor="end" font-weight="600"')}
      ${rowSvg}
    </svg>
  `);

  return sharp(svg).png().toBuffer();
}
