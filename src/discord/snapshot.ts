import sharp from "sharp";
import { itemIconCdnBase } from "./enabled";
import {
  contentTypeLabel,
  formatFame,
  formatItemPower,
  formatSilver,
  formatUtcStamp,
  itemIconCacheKey,
  regionLabel,
} from "./format";
import {
  itemsFor,
  type KillSnapshot,
  type KillSnapshotItem,
  type KillSnapshotParticipant,
} from "./kill-data";
import { estimateItemsSilver } from "./silver";

const S = 1.6;
const T = 2.2;
const TF = 2.0;
function u(n: number): number {
  return Math.round(n * S);
}
function tx(n: number): number {
  return Math.round(n * TF);
}

const ICON = Math.round(60 * T);
const GAP = Math.round(8 * T);
const CELL = ICON + GAP;
const COL_WIDTH = CELL * 2 + ICON;
const WIDTH = u(1200);
const PAD = u(36);
const MID_GAP = u(14);
const FAME_W = u(280);
const SIDE_W = (WIDTH - PAD * 2 - FAME_W - MID_GAP * 2) / 2;
const SUMMARY_Y = u(72);
const SUMMARY_H = u(188);
const GEAR_GAP = u(20);
const GEAR_CARD_W = (WIDTH - PAD * 2 - GEAR_GAP) / 2;
const GEAR_CARD_Y = SUMMARY_Y + SUMMARY_H + u(16);
const GEAR_HEADER = u(128);
const GEAR_GRID_H = CELL * 3 + ICON;
const GEAR_CARD_H = GEAR_HEADER + GEAR_GRID_H + u(28);
const GEAR_Y = GEAR_CARD_Y + GEAR_HEADER;
const BOTTOM_Y = GEAR_CARD_Y + GEAR_CARD_H + u(16);
const LOOT_H = u(72) + ICON + u(32);
const HEIGHT = BOTTOM_Y + LOOT_H + PAD;

/** Same paper-doll order as the kill page (`KillGearPanels` / `gear.png`). */
const SLOT_GRID: { slot: string; col: number; row: number }[] = [
  { slot: "Bag", col: 0, row: 0 },
  { slot: "Head", col: 1, row: 0 },
  { slot: "Cape", col: 2, row: 0 },
  { slot: "MainHand", col: 0, row: 1 },
  { slot: "Armor", col: 1, row: 1 },
  { slot: "OffHand", col: 2, row: 1 },
  { slot: "Food", col: 0, row: 2 },
  { slot: "Shoes", col: 1, row: 2 },
  { slot: "Potion", col: 2, row: 2 },
  { slot: "Mount", col: 1, row: 3 },
];

const iconCache = new Map<string, Buffer | null>();

async function fetchIcon(item: KillSnapshotItem): Promise<Buffer | null> {
  const key = itemIconCacheKey(item.itemType, item.quality);
  if (iconCache.has(key)) return iconCache.get(key) ?? null;

  const url = `${itemIconCdnBase()}/${key}.png`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      iconCache.set(key, null);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const resized = await sharp(buf).resize(ICON, ICON).png().toBuffer();
    iconCache.set(key, resized);
    return resized;
  } catch {
    iconCache.set(key, null);
    return null;
  }
}

function slotItem(
  items: KillSnapshotItem[],
  slot: string
): KillSnapshotItem | undefined {
  return items.find((item) => item.slot === slot);
}

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
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-family="Segoe UI, Arial, sans-serif" ${extra}>${escapeXml(text)}</text>`;
}

function playerGuildLine(player: KillSnapshotParticipant | null): string {
  const guild = player?.guildName?.trim() || "No guild";
  const tag = player?.allianceTag?.trim();
  return tag ? `${guild}  <${tag}>` : guild;
}

type Overlay = {
  input: Buffer;
  left: number;
  top: number;
};

async function compositeColumn(
  items: KillSnapshotItem[],
  originX: number,
  originY: number
): Promise<Overlay[]> {
  const overlays: Overlay[] = [];
  for (const cell of SLOT_GRID) {
    const item = slotItem(items, cell.slot);
    if (!item) continue;
    const icon = await fetchIcon(item);
    if (!icon) continue;
    overlays.push({
      input: icon,
      left: Math.round(originX + cell.col * CELL),
      top: Math.round(originY + cell.row * CELL),
    });
  }
  return overlays;
}

function gearSlotFrames(originX: number, originY: number): string {
  return SLOT_GRID.map((cell) => {
    const x = originX + cell.col * CELL;
    const y = originY + cell.row * CELL;
    return `<rect x="${x}" y="${y}" width="${ICON}" height="${ICON}" rx="${u(10)}" fill="#0c0f14" stroke="#2a3441"/>`;
  }).join("");
}

async function compositeInventory(
  items: KillSnapshotItem[],
  originX: number,
  originY: number,
  max = 12
): Promise<Overlay[]> {
  const overlays: Overlay[] = [];
  const shown = items.slice(0, max);
  for (let i = 0; i < shown.length; i++) {
    const icon = await fetchIcon(shown[i]!);
    if (!icon) continue;
    overlays.push({
      input: icon,
      left: Math.round(originX + i * (ICON + u(4))),
      top: Math.round(originY),
    });
  }
  return overlays;
}

function playerSummary(options: {
  x: number;
  width: number;
  role: string;
  accent: string;
  player: KillSnapshotParticipant | null;
}): string {
  const { x, width, role, accent, player } = options;
  const cx = x + width / 2;
  const name = truncate(player?.name?.trim() || "Unknown", 20);
  const guild = truncate(playerGuildLine(player), 28);
  const ip = formatItemPower(player?.averageItemPower);
  const y = SUMMARY_Y;

  return `
    <rect x="${x}" y="${y}" width="${width}" height="${SUMMARY_H}" rx="${u(16)}" fill="#12171e" stroke="#2a3441"/>
    ${svgText(role, cx, y + u(38), tx(13), accent, 'text-anchor="middle" font-weight="700" letter-spacing="2.8"')}
    ${svgText(name, cx, y + u(78), tx(26), "#e8edf2", 'text-anchor="middle" font-weight="700"')}
    ${svgText(guild, cx, y + u(112), tx(16), "#7d8b9a", 'text-anchor="middle" font-weight="500"')}
    ${svgText(`${ip} IP`, cx, y + u(150), tx(18), "#38bdf8", 'text-anchor="middle" font-weight="600"')}
  `;
}

function fameSummary(options: {
  x: number;
  fame: string;
  content: string;
  meta: string;
}): string {
  const { x, fame, content, meta } = options;
  const cx = x + FAME_W / 2;
  const y = SUMMARY_Y;

  return `
    <rect x="${x}" y="${y}" width="${FAME_W}" height="${SUMMARY_H}" rx="${u(16)}" fill="#12171e" stroke="#2a3441"/>
    ${svgText("KILL FAME", cx, y + u(38), tx(13), "#f5c14a", 'text-anchor="middle" font-weight="700" letter-spacing="2.8"')}
    ${svgText(fame, cx, y + u(92), tx(40), "#f5c14a", 'text-anchor="middle" font-weight="700"')}
    ${svgText(content, cx, y + u(130), tx(16), "#d7e0ea", 'text-anchor="middle" font-weight="600"')}
    ${svgText(meta, cx, y + u(160), tx(13), "#7d8b9a", 'text-anchor="middle" font-weight="500"')}
  `;
}

function gearCard(options: {
  x: number;
  title: string;
  accent: string;
  ip: string;
  silver: string;
}): string {
  const { x, title, accent, ip, silver } = options;
  const y = GEAR_CARD_Y;

  return `
    <rect x="${x}" y="${y}" width="${GEAR_CARD_W}" height="${GEAR_CARD_H}" rx="${u(16)}" fill="#12171e" stroke="#2a3441"/>
    ${svgText(title, x + u(24), y + u(42), tx(18), accent, 'font-weight="700"')}
    ${svgText(silver, x + GEAR_CARD_W - u(24), y + u(42), tx(16), "#9aa7b5", 'text-anchor="end" font-weight="500"')}
    ${svgText("Average IP", x + u(24), y + u(78), tx(16), "#7d8b9a", 'font-weight="500"')}
    ${svgText(ip, x + u(168), y + u(78), tx(16), "#38bdf8", 'font-weight="600"')}
  `;
}

export async function renderKillSnapshotPng(
  snapshot: KillSnapshot
): Promise<Buffer> {
  const killerGear = itemsFor(snapshot, "killer", "equipment");
  const victimGear = itemsFor(snapshot, "victim", "equipment");
  const loot = itemsFor(snapshot, "victim", "inventory");

  const [killerSilver, victimLost] = await Promise.all([
    estimateItemsSilver(snapshot.region, killerGear),
    estimateItemsSilver(snapshot.region, [...victimGear, ...loot]),
  ]);

  const fame = formatFame(snapshot.totalVictimKillFame ?? 0);
  const content = contentTypeLabel(snapshot.contentType);
  const assists =
    snapshot.assistCount > 0
      ? snapshot.assistCount === 1
        ? "1 assist"
        : `${snapshot.assistCount} assists`
      : null;
  const contentLine = [content, assists].filter(Boolean).join(" · ");
  const when = formatUtcStamp(snapshot.occurredAt);
  const meta = `${regionLabel(snapshot.region)} · ${when}`;

  const killerX = PAD;
  const fameX = PAD + SIDE_W + MID_GAP;
  const victimX = fameX + FAME_W + MID_GAP;
  const killerGearX = PAD;
  const victimGearX = PAD + GEAR_CARD_W + GEAR_GAP;
  const gearOffsetX = (GEAR_CARD_W - COL_WIDTH) / 2;
  const lootX = PAD + u(24);
  const lootY = BOTTOM_Y + u(72);

  const svg = Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#0c0f14"/>
      ${svgText("aotracker.net", PAD, u(48), tx(24), "#e8edf2", 'font-weight="700"')}
      ${playerSummary({
        x: killerX,
        width: SIDE_W,
        role: "KILLER",
        accent: "#3dd68c",
        player: snapshot.killer,
      })}
      ${fameSummary({
        x: fameX,
        fame,
        content: contentLine,
        meta,
      })}
      ${playerSummary({
        x: victimX,
        width: SIDE_W,
        role: "VICTIM",
        accent: "#e85d5d",
        player: snapshot.victim,
      })}
      ${gearCard({
        x: killerGearX,
        title: "Killer's Equipment",
        accent: "#3dd68c",
        ip: formatItemPower(snapshot.killer?.averageItemPower),
        silver: `Est. value  ${formatSilver(killerSilver)}`,
      })}
      ${gearCard({
        x: victimGearX,
        title: "Victim's Equipment",
        accent: "#e85d5d",
        ip: formatItemPower(snapshot.victim?.averageItemPower),
        silver: `Est. value  ${formatSilver(victimLost)}`,
      })}
      ${gearSlotFrames(killerGearX + gearOffsetX, GEAR_Y)}
      ${gearSlotFrames(victimGearX + gearOffsetX, GEAR_Y)}
      <rect x="${PAD}" y="${BOTTOM_Y}" width="${WIDTH - PAD * 2}" height="${HEIGHT - BOTTOM_Y - PAD}" rx="${u(16)}" fill="#12171e" stroke="#2a3441"/>
      ${svgText("LOOT", PAD + u(24), BOTTOM_Y + u(40), tx(15), "#9aa7b5", 'font-weight="700" letter-spacing="2.8"')}
      ${
        loot.length === 0
          ? svgText("None", PAD + u(24), BOTTOM_Y + u(96), tx(18), "#5f6b78", 'font-weight="500"')
          : ""
      }
    </svg>
  `);

  const base = await sharp(svg).png().toBuffer();
  const overlays: Overlay[] = [
    ...(await compositeColumn(killerGear, killerGearX + gearOffsetX, GEAR_Y)),
    ...(await compositeColumn(victimGear, victimGearX + gearOffsetX, GEAR_Y)),
    ...(await compositeInventory(loot, lootX, lootY)),
  ];

  return sharp(base).composite(overlays).png().toBuffer();
}
