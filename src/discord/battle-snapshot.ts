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

/** Compact chrome so the scoreboard can own the frame. */
const TABLE_Y = 108;
const TABLE_X = 36;
const TABLE_W = 1128;
const ROW_H = 108;
const ROW_START = 210;
const NAME_SIZE = 30;
const STAT_SIZE = 28;

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

function identityLine(input: {
  snapshot: BattleSnapshot;
  trackedName: string;
}): string {
  const { snapshot } = input;
  const battle =
    snapshot.albionBattleId > 0
      ? `#${snapshot.albionBattleId}`
      : `${input.trackedName} recap`;
  return [battle, battleImageSubtitle(snapshot)].join(" · ");
}

function cell(
  guild: BattleGuildScore,
  y: number,
  highlight: boolean
): string {
  const nameFill = highlight ? COLOR.highlight : COLOR.fg;
  const rowBg = highlight
    ? `<rect x="56" y="${y - 48}" width="1088" height="96" rx="10" fill="rgba(245,193,74,0.14)"/>`
    : "";
  return `
    ${rowBg}
    ${svgText(truncate(guild.name, 18), 72, y, NAME_SIZE, nameFill, 'font-weight="700"')}
    ${svgText(truncate(guild.alliance?.trim() || "—", 16), 360, y, 24, COLOR.muted)}
    ${svgText((guild.players > 0 ? guild.players : 0).toLocaleString(), 580, y, STAT_SIZE, COLOR.text, 'text-anchor="end" font-weight="700"')}
    ${svgText(guild.kills.toLocaleString(), 710, y, STAT_SIZE, COLOR.kill, 'text-anchor="end" font-weight="700"')}
    ${svgText(guild.deaths.toLocaleString(), 840, y, STAT_SIZE, COLOR.death, 'text-anchor="end" font-weight="700"')}
    ${svgText(formatItemPower(guild.averageIp), 970, y, STAT_SIZE, COLOR.ip, 'text-anchor="end" font-weight="700"')}
    ${svgText(formatFame(guild.killFame), 1136, y, STAT_SIZE, COLOR.fame, 'text-anchor="end" font-weight="700"')}
  `;
}

export function buildBattleSnapshotSvg(input: {
  snapshot: BattleSnapshot;
  trackedGuildId: string;
  trackedGuildName?: string | null;
  preview?: boolean;
}): string {
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
  const trackedName = tracked?.name ?? input.trackedGuildName ?? "Guild";
  const identity = identityLine({
    snapshot,
    trackedName,
  });
  const badge = input.preview ? "Preview" : "Albion Battle";
  const tableH = HEIGHT - TABLE_Y - 28;

  const rowSvg = rows
    .map((guild, index) =>
      cell(
        guild,
        ROW_START + index * ROW_H,
        Boolean(
          tracked &&
            (guild.id === tracked.id || guild.name === tracked.name)
        )
      )
    )
    .join("");

  return `
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0c0f14"/>
          <stop offset="55%" stop-color="#151a22"/>
          <stop offset="100%" stop-color="#1a2330"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)"/>
      ${svgText(SITE_NAME, 44, 48, 20, COLOR.fg, 'font-weight="700"')}
      <rect x="1000" y="22" width="156" height="34" rx="17" fill="none" stroke="${COLOR.border}"/>
      ${svgText(badge, 1078, 45, 15, COLOR.muted, 'text-anchor="middle"')}
      ${svgText(identity, 44, 82, 20, COLOR.muted)}
      <rect x="${TABLE_X}" y="${TABLE_Y}" width="${TABLE_W}" height="${tableH}" rx="16" fill="rgba(12,15,20,0.55)" stroke="${COLOR.border}"/>
      ${svgText("GUILD", 72, 148, 15, COLOR.muted, 'font-weight="600"')}
      ${svgText("ALLIANCE", 360, 148, 15, COLOR.muted, 'font-weight="600"')}
      ${svgText("PLAYERS", 580, 148, 15, COLOR.muted, 'text-anchor="end" font-weight="600"')}
      ${svgText("KILLS", 710, 148, 15, COLOR.kill, 'text-anchor="end" font-weight="600"')}
      ${svgText("DEATHS", 840, 148, 15, COLOR.death, 'text-anchor="end" font-weight="600"')}
      ${svgText("AVG IP", 970, 148, 15, COLOR.ip, 'text-anchor="end" font-weight="600"')}
      ${svgText("FAME", 1136, 148, 15, COLOR.fame, 'text-anchor="end" font-weight="600"')}
      ${rowSvg}
    </svg>
  `;
}

export async function renderBattleSnapshotPng(input: {
  snapshot: BattleSnapshot;
  trackedGuildId: string;
  trackedGuildName?: string | null;
  preview?: boolean;
}): Promise<Buffer> {
  return sharp(Buffer.from(buildBattleSnapshotSvg(input))).png().toBuffer();
}
