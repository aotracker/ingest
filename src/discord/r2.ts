import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { snapshotCdnBase } from "./enabled";

const R2_ENV = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
] as const;

/** Match Discord embed lifetime; pair with an R2 lifecycle rule on `snapshots/`. */
const SNAPSHOT_CACHE_CONTROL = "public, max-age=604800";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function isR2Configured(): boolean {
  return R2_ENV.every((name) => Boolean(process.env[name]?.trim()));
}

let client: S3Client | null = null;

function r2Client(): S3Client {
  if (client) return client;
  const accountId = requireEnv("R2_ACCOUNT_ID");
  client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
  return client;
}

/** Stable key so retries / kill+death feeds overwrite one object per event. */
export function snapshotObjectKey(region: string, eventId: number): string {
  return `snapshots/${region}/${eventId}.png`;
}

export function snapshotPublicUrl(region: string, eventId: number): string {
  return `${snapshotCdnBase()}/${region}/${eventId}.png`;
}

/**
 * One object per battle + tracked guild (feeds highlight different guilds).
 * Guild id is sanitized for object keys.
 */
export function battleSnapshotObjectKey(
  region: string,
  battleId: number,
  trackedGuildId: string
): string {
  const guildKey = trackedGuildId.replace(/[^a-zA-Z0-9_-]/g, "_") || "guild";
  return `snapshots/${region}/battle-${battleId}-${guildKey}.png`;
}

export function battleSnapshotPublicUrl(
  region: string,
  battleId: number,
  trackedGuildId: string
): string {
  const guildKey = trackedGuildId.replace(/[^a-zA-Z0-9_-]/g, "_") || "guild";
  return `${snapshotCdnBase()}/${region}/battle-${battleId}-${guildKey}.png`;
}

export async function uploadSnapshotPng(
  region: string,
  eventId: number,
  body: Buffer
): Promise<string> {
  const bucket = requireEnv("R2_BUCKET_NAME");
  const key = snapshotObjectKey(region, eventId);
  await r2Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "image/png",
      CacheControl: SNAPSHOT_CACHE_CONTROL,
    })
  );
  return snapshotPublicUrl(region, eventId);
}

export async function uploadBattleSnapshotPng(
  region: string,
  battleId: number,
  trackedGuildId: string,
  body: Buffer
): Promise<string> {
  const bucket = requireEnv("R2_BUCKET_NAME");
  const key = battleSnapshotObjectKey(region, battleId, trackedGuildId);
  await r2Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "image/png",
      CacheControl: SNAPSHOT_CACHE_CONTROL,
    })
  );
  return battleSnapshotPublicUrl(region, battleId, trackedGuildId);
}
