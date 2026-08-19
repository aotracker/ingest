import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { itemIconCdnBase } from "./enabled";
import {
  contentTypeLabel,
  formatFame,
  formatItemPower,
  formatSilver,
  formatUtcStampShort,
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
const TF = 2.0;
function u(n: number): number {
  return Math.round(n * S);
}
function tx(n: number): number {
  return Math.round(n * TF);
}

const ASSETS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "assets"
);

const COLOR = {
  bg: "#080c14",
  card: "#0c121c",
  border: "#1e2a38",
  fg: "#e8edf2",
  muted: "#7d8b9a",
  kill: "#3dd68c",
  death: "#e85d5d",
  fame: "#f5c14a",
  ip: "#38bdf8",
} as const;

const CONTENT_BADGE: Record<string, { fill: string; stroke: string; text: string }> = {
  ZVZ: { fill: "#3f1515", stroke: "#7f1d1d", text: "#fca5a5" },
  SOLO: { fill: "#172554", stroke: "#1e3a8a", text: "#93c5fd" },
  GROUP: { fill: "#422006", stroke: "#92400e", text: "#fcd34d" },
};

/** Same overlay map as `KillGearPanels` on `public/gear.png` (480×520). */
const SLOT_POSITIONS: { slot: string; left: number; top: number }[] = [
  { slot: "Bag", left: 0.051, top: 0.0567 },
  { slot: "Head", left: 0.3698, top: 0.0837 },
  { slot: "Cape", left: 0.6927, top: 0.0567 },
  { slot: "MainHand", left: 0.1063, top: 0.2933 },
  { slot: "Armor", left: 0.3698, top: 0.2933 },
  { slot: "OffHand", left: 0.6438, top: 0.2933 },
  { slot: "Food", left: 0.0615, top: 0.5394 },
  { slot: "Shoes", left: 0.3698, top: 0.5144 },
  { slot: "Potion", left: 0.6885, top: 0.5394 },
  { slot: "Mount", left: 0.3698, top: 0.726 },
];
const SLOT_SIZE = { width: 0.25, height: 0.2308 };

const KILLBOARD = {
  fame: 0,
  skull: 9,
  silver: 10,
} as const;
const KILLBOARD_FRAMES = 14;

const WIDTH = u(1200);
const PAD = u(28);
const CARD_X = PAD;
const CARD_W = WIDTH - PAD * 2;
const CENTER_W = u(210);
const SIDE_W = (CARD_W - CENTER_W) / 2;
const HEADER_Y = u(48);
const CARD_Y = u(68);
const COL_PAD = u(18);
const PLAYER_HEAD_H = u(118);
const GEAR_W = Math.min(u(320), Math.round(SIDE_W - COL_PAD * 2));
const GEAR_H = Math.round((GEAR_W * 520) / 480);
const SLOT_PX = Math.round(GEAR_W * SLOT_SIZE.width);
const CARD_H = PLAYER_HEAD_H + GEAR_H + u(28);
const LOOT_GAP = u(16);
const LOOT_ICON = Math.round(56 * 1.8);
const LOOT_CELL = LOOT_ICON + u(10);

const iconCache = new Map<string, Buffer | null>();
let gearTemplate: Buffer | null | undefined;
let killboardSprite: Buffer | null | undefined;

type Overlay = {
  input: Buffer;
  left: number;
  top: number;
};

async function readAsset(name: string): Promise<Buffer | null> {
  try {
    return await readFile(path.join(ASSETS_DIR, name));
  } catch {
    return null;
  }
}

async function loadGearTemplate(): Promise<Buffer | null> {
  if (gearTemplate !== undefined) return gearTemplate;
  const file = await readAsset("gear.png");
  gearTemplate = file
    ? await sharp(file).resize(GEAR_W, GEAR_H).png().toBuffer()
    : null;
  return gearTemplate;
}

async function loadKillboardSprite(): Promise<Buffer | null> {
  if (killboardSprite !== undefined) return killboardSprite;
  killboardSprite = await readAsset("killboard-icons.png");
  return killboardSprite;
}

async function killboardIcon(
  name: keyof typeof KILLBOARD,
  size: number
): Promise<Buffer | null> {
  const sprite = await loadKillboardSprite();
  if (!sprite) return null;
  const meta = await sharp(sprite).metadata();
  const frameW = Math.round((meta.width ?? 1540) / KILLBOARD_FRAMES);
  const frameH = meta.height ?? 100;
  const index = KILLBOARD[name];
  try {
    return await sharp(sprite)
      .extract({ left: index * frameW, top: 0, width: frameW, height: frameH })
      .resize(size, size)
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

async function fetchIcon(
  item: KillSnapshotItem,
  size: number
): Promise<Buffer | null> {
  const key = `${itemIconCacheKey(item.itemType, item.quality)}@${size}`;
  if (iconCache.has(key)) return iconCache.get(key) ?? null;

  const url = `${itemIconCdnBase()}/${itemIconCacheKey(item.itemType, item.quality)}.png`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      iconCache.set(key, null);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const resized = await sharp(buf)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
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
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-family="Arial, Helvetica, sans-serif" ${extra}>${escapeXml(text)}</text>`;
}

function playerGuildLine(player: KillSnapshotParticipant | null): string {
  return player?.guildName?.trim() || "";
}

function contentKind(type: string): "ZVZ" | "SOLO" | "GROUP" {
  if (type === "ZVZ" || type === "SOLO") return type;
  return "GROUP";
}

function estimateTextWidth(text: string, size: number): number {
  return Math.ceil(text.length * size * 0.62);
}

async function compositePaperDoll(
  items: KillSnapshotItem[],
  originX: number,
  originY: number
): Promise<Overlay[]> {
  const overlays: Overlay[] = [];
  const template = await loadGearTemplate();
  if (template) {
    overlays.push({ input: template, left: originX, top: originY });
  }
  for (const cell of SLOT_POSITIONS) {
    const item = slotItem(items, cell.slot);
    if (!item) continue;
    const icon = await fetchIcon(item, SLOT_PX);
    if (!icon) continue;
    overlays.push({
      input: icon,
      left: Math.round(originX + GEAR_W * cell.left),
      top: Math.round(originY + GEAR_H * cell.top),
    });
  }
  return overlays;
}

async function compositeInventory(
  items: KillSnapshotItem[],
  originX: number,
  originY: number,
  maxCols: number
): Promise<Overlay[]> {
  const overlays: Overlay[] = [];
  for (let i = 0; i < items.length; i++) {
    const icon = await fetchIcon(items[i]!, LOOT_ICON);
    if (!icon) continue;
    const col = i % maxCols;
    const row = Math.floor(i / maxCols);
    overlays.push({
      input: icon,
      left: Math.round(originX + col * LOOT_CELL),
      top: Math.round(originY + row * LOOT_CELL),
    });
  }
  return overlays;
}

const SILVER_ICON = u(16);

function silverValueLayout(options: {
  silver: string;
  fontSize: number;
  iconSize: number;
}): { width: number; iconGap: number } {
  const iconGap = u(4);
  const textW = estimateTextWidth(options.silver, options.fontSize);
  return {
    width: options.silver ? options.iconSize + iconGap + textW : 0,
    iconGap,
  };
}

function playerColumn(options: {
  x: number;
  role: string;
  accent: string;
  player: KillSnapshotParticipant | null;
  ip: string;
  silver: string;
}): { svg: string; silverIcon: { x: number; y: number } | null } {
  const { x, role, accent, player, ip, silver } = options;
  const cx = x + SIDE_W / 2;
  const y = CARD_Y;
  const name = truncate(player?.name?.trim() || "Unknown", 22);
  const guild = truncate(playerGuildLine(player), 32);
  const ipText = ip !== "—" ? `${ip} IP` : "";
  const statsY = y + u(108);
  const fontSize = tx(14);
  const ipW = ipText ? estimateTextWidth(ipText, fontSize) : 0;
  const silverLayout = silverValueLayout({
    silver,
    fontSize,
    iconSize: SILVER_ICON,
  });
  const gap = ipText && silver ? u(14) : 0;
  const totalW = ipW + gap + silverLayout.width;
  let cursor = cx - totalW / 2;
  let statsSvg = "";
  let silverIcon: { x: number; y: number } | null = null;

  if (ipText) {
    statsSvg += svgText(
      ipText,
      cursor,
      statsY,
      fontSize,
      COLOR.ip,
      'font-weight="600"'
    );
    cursor += ipW + gap;
  }
  if (silver) {
    silverIcon = { x: cursor, y: statsY - SILVER_ICON + u(3) };
    cursor += SILVER_ICON + silverLayout.iconGap;
    statsSvg += svgText(
      silver,
      cursor,
      statsY,
      fontSize,
      COLOR.muted,
      'font-weight="500"'
    );
  }

  return {
    svg: `
    ${svgText(role, cx, y + u(28), tx(12), accent, 'text-anchor="middle" font-weight="700" letter-spacing="1.8"')}
    ${svgText(name, cx, y + u(58), tx(22), COLOR.fg, 'text-anchor="middle" font-weight="700"')}
    ${guild ? svgText(guild, cx, y + u(82), tx(14), COLOR.muted, 'text-anchor="middle" font-weight="500"') : ""}
    ${statsSvg}
  `,
    silverIcon,
  };
}

function matchMeta(options: {
  x: number;
  fame: string;
  content: string;
  contentType: string;
  region: string;
  when: string;
  assists: string | null;
}): string {
  const { x, fame, content, contentType, region, when, assists } = options;
  const cx = x + CENTER_W / 2;
  const y = CARD_Y;
  const kind = contentKind(contentType);
  const badge = CONTENT_BADGE[kind] ?? CONTENT_BADGE.GROUP;
  const badgeLabel = content;
  const badgeW = Math.max(u(64), estimateTextWidth(badgeLabel, tx(12)) + u(18));
  const badgeH = u(22);
  const badgeX = cx - badgeW / 2;
  const fameBlockY = y + Math.round(CARD_H * 0.42);
  const badgeY = fameBlockY + u(72);

  return `
    <line x1="${x}" y1="${CARD_Y + u(12)}" x2="${x}" y2="${CARD_Y + CARD_H - u(12)}" stroke="${COLOR.border}"/>
    <line x1="${x + CENTER_W}" y1="${CARD_Y + u(12)}" x2="${x + CENTER_W}" y2="${CARD_Y + CARD_H - u(12)}" stroke="${COLOR.border}"/>
    ${svgText("KILLED", cx, y + u(42), tx(13), COLOR.fg, 'text-anchor="middle" font-weight="700" letter-spacing="3.2"')}
    ${svgText(when, cx, y + u(68), tx(12), COLOR.muted, 'text-anchor="middle" font-weight="500"')}
    ${svgText("KILL FAME", cx, fameBlockY + u(12), tx(11), COLOR.muted, 'text-anchor="middle" font-weight="700" letter-spacing="1.6"')}
    ${svgText(fame, cx, fameBlockY + u(52), tx(32), COLOR.fame, 'text-anchor="middle" font-weight="700"')}
    <rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="${u(5)}" fill="${badge.fill}" stroke="${badge.stroke}"/>
    ${svgText(badgeLabel, cx, badgeY + u(16), tx(12), badge.text, 'text-anchor="middle" font-weight="600"')}
    ${svgText(region, cx, badgeY + u(44), tx(12), COLOR.muted, 'text-anchor="middle" font-weight="500"')}
    ${assists ? svgText(assists, cx, badgeY + u(66), tx(12), COLOR.muted, 'text-anchor="middle" font-weight="500"') : ""}
  `;
}

function gearSlotFrames(originX: number, originY: number): string {
  return SLOT_POSITIONS.map((cell) => {
    const x = originX + GEAR_W * cell.left;
    const y = originY + GEAR_H * cell.top;
    return `<rect x="${x}" y="${y}" width="${SLOT_PX}" height="${SLOT_PX}" rx="${u(8)}" fill="#080c14" stroke="${COLOR.border}"/>`;
  }).join("");
}

function lootCard(options: {
  y: number;
  height: number;
  count: number;
  silver: string;
  iconsX: number;
  iconsY: number;
  maxCols: number;
}): { svg: string; silverIcon: { x: number; y: number } | null } {
  const { y, height, count, silver, iconsX, iconsY, maxCols } = options;
  const itemsLabel = count === 1 ? "1 item" : `${count} items`;
  const fontSize = tx(13);
  const headerY = y + u(36);
  const rightEdge = CARD_X + CARD_W - u(22);
  const itemsW = estimateTextWidth(itemsLabel, fontSize);
  const itemsX = rightEdge - itemsW;
  const silverLayout = silverValueLayout({
    silver,
    fontSize,
    iconSize: SILVER_ICON,
  });
  const silverBlockX = silver
    ? itemsX - u(14) - silverLayout.width
    : null;
  let silverIcon: { x: number; y: number } | null = null;
  let silverSvg = "";
  if (silver && silverBlockX != null) {
    silverIcon = { x: silverBlockX, y: headerY - SILVER_ICON + u(3) };
    silverSvg = svgText(
      silver,
      silverBlockX + SILVER_ICON + silverLayout.iconGap,
      headerY,
      fontSize,
      COLOR.muted,
      'font-weight="500"'
    );
  }
  const frames = Array.from({ length: count }, (_, i) => {
    const col = i % maxCols;
    const row = Math.floor(i / maxCols);
    const x = iconsX + col * LOOT_CELL;
    const frameY = iconsY + row * LOOT_CELL;
    return `<rect x="${x}" y="${frameY}" width="${LOOT_ICON}" height="${LOOT_ICON}" rx="${u(6)}" fill="#10151d" stroke="${COLOR.border}"/>`;
  }).join("");
  return {
    svg: `
    <rect x="${CARD_X}" y="${y}" width="${CARD_W}" height="${height}" rx="${u(12)}" fill="${COLOR.card}" stroke="${COLOR.border}"/>
    ${svgText("Victim loot", CARD_X + u(22), headerY, tx(16), COLOR.fg, 'font-weight="700"')}
    ${silverSvg}
    ${svgText(itemsLabel, itemsX, headerY, fontSize, COLOR.muted, 'font-weight="500"')}
    ${frames}
  `,
    silverIcon,
  };
}

export async function renderKillSnapshotPng(
  snapshot: KillSnapshot
): Promise<Buffer> {
  const killerGear = itemsFor(snapshot, "killer", "equipment");
  const victimGear = itemsFor(snapshot, "victim", "equipment");
  const loot = itemsFor(snapshot, "victim", "inventory");

  const [killerSilver, victimSilver, lootSilver] = await Promise.all([
    estimateItemsSilver(snapshot.region, killerGear),
    estimateItemsSilver(snapshot.region, victimGear),
    estimateItemsSilver(snapshot.region, loot),
  ]);

  const fame = formatFame(snapshot.totalVictimKillFame ?? 0);
  const content = contentTypeLabel(snapshot.contentType);
  const assists =
    snapshot.assistCount > 0
      ? snapshot.assistCount === 1
        ? "1 assist"
        : `${snapshot.assistCount} assists`
      : null;
  const when = formatUtcStampShort(snapshot.occurredAt);
  const region = regionLabel(snapshot.region);

  const killerColX = CARD_X;
  const centerX = CARD_X + SIDE_W;
  const victimColX = centerX + CENTER_W;
  const killerGearX = Math.round(killerColX + (SIDE_W - GEAR_W) / 2);
  const victimGearX = Math.round(victimColX + (SIDE_W - GEAR_W) / 2);
  const gearY = CARD_Y + PLAYER_HEAD_H;

  const showLoot = loot.length > 0;
  const lootMaxCols = Math.max(
    1,
    Math.floor((CARD_W - u(44)) / LOOT_CELL)
  );
  const lootRows = showLoot ? Math.ceil(loot.length / lootMaxCols) : 0;
  const lootY = CARD_Y + CARD_H + LOOT_GAP;
  const lootH = showLoot ? u(56) + lootRows * LOOT_CELL + u(20) : 0;
  const lootIconsY = lootY + u(56);
  const lootIconsX = CARD_X + u(22);
  const HEIGHT = lootY + (showLoot ? lootH : 0) + PAD;

  const iconSize = u(22);
  const fameBlockY = CARD_Y + Math.round(CARD_H * 0.42);
  const hasGearArt = Boolean(await loadGearTemplate());
  const killerCol = playerColumn({
    x: killerColX,
    role: "KILLER",
    accent: COLOR.kill,
    player: snapshot.killer,
    ip: formatItemPower(snapshot.killer?.averageItemPower),
    silver: killerSilver > 0 ? formatSilver(killerSilver) : "",
  });
  const victimCol = playerColumn({
    x: victimColX,
    role: "VICTIM",
    accent: COLOR.death,
    player: snapshot.victim,
    ip: formatItemPower(snapshot.victim?.averageItemPower),
    silver: victimSilver > 0 ? formatSilver(victimSilver) : "",
  });
  const lootPanel = showLoot
    ? lootCard({
        y: lootY,
        height: lootH,
        count: loot.length,
        silver: lootSilver > 0 ? formatSilver(lootSilver) : "",
        iconsX: lootIconsX,
        iconsY: lootIconsY,
        maxCols: lootMaxCols,
      })
    : null;
  const needSilverIcon = Boolean(
    killerCol.silverIcon || victimCol.silverIcon || lootPanel?.silverIcon
  );
  const [skull, fameIcon, silverIcon] = await Promise.all([
    killboardIcon("skull", iconSize),
    killboardIcon("fame", iconSize),
    needSilverIcon ? killboardIcon("silver", SILVER_ICON) : Promise.resolve(null),
  ]);

  const svg = Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="${COLOR.bg}"/>
      ${svgText("aotracker.net", PAD, HEADER_Y, tx(18), COLOR.fg, 'font-weight="700"')}
      <rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_W}" height="${CARD_H}" rx="${u(12)}" fill="${COLOR.card}" stroke="${COLOR.border}"/>
      ${hasGearArt ? "" : `${gearSlotFrames(killerGearX, gearY)}${gearSlotFrames(victimGearX, gearY)}`}
      ${killerCol.svg}
      ${matchMeta({
        x: centerX,
        fame,
        content,
        contentType: snapshot.contentType,
        region,
        when,
        assists,
      })}
      ${victimCol.svg}
      ${lootPanel?.svg ?? ""}
    </svg>
  `);

  const base = await sharp(svg).png().toBuffer();
  const overlays: Overlay[] = [
    ...(await compositePaperDoll(killerGear, killerGearX, gearY)),
    ...(await compositePaperDoll(victimGear, victimGearX, gearY)),
  ];

  if (showLoot) {
    overlays.push(
      ...(await compositeInventory(loot, lootIconsX, lootIconsY, lootMaxCols))
    );
  }

  const cx = centerX + CENTER_W / 2;
  if (skull) {
    overlays.push({
      input: skull,
      left: Math.round(
        cx - estimateTextWidth("KILLED", tx(13)) / 2 - iconSize - u(8)
      ),
      top: CARD_Y + u(22),
    });
  }
  if (fameIcon) {
    overlays.push({
      input: fameIcon,
      left: Math.round(cx - iconSize / 2),
      top: fameBlockY - u(28),
    });
  }
  if (silverIcon) {
    for (const pos of [
      killerCol.silverIcon,
      victimCol.silverIcon,
      lootPanel?.silverIcon ?? null,
    ]) {
      if (!pos) continue;
      overlays.push({
        input: silverIcon,
        left: Math.round(pos.x),
        top: Math.round(pos.y),
      });
    }
  }

  return sharp(base).composite(overlays).png().toBuffer();
}
