import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { snapshotCdnBase } from "./enabled";

const R2_ENV = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
] as const;

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

export function snapshotObjectKey(
  region: string,
  eventId: number,
  digest: string
): string {
  return `snapshots/${region}/${eventId}-${digest}.png`;
}

export function snapshotPublicUrl(
  region: string,
  eventId: number,
  digest: string
): string {
  return `${snapshotCdnBase()}/${region}/${eventId}-${digest}.png`;
}

export function battleSnapshotObjectKey(
  region: string,
  battleId: number,
  digest: string
): string {
  return `snapshots/${region}/battle-${battleId}-${digest}.png`;
}

export function battleSnapshotPublicUrl(
  region: string,
  battleId: number,
  digest: string
): string {
  return `${snapshotCdnBase()}/${region}/battle-${battleId}-${digest}.png`;
}

function pngDigest(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

export async function uploadSnapshotPng(
  region: string,
  eventId: number,
  body: Buffer
): Promise<string> {
  const bucket = requireEnv("R2_BUCKET_NAME");
  const digest = pngDigest(body);
  const key = snapshotObjectKey(region, eventId, digest);
  await r2Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "image/png",
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
  return snapshotPublicUrl(region, eventId, digest);
}

export async function uploadBattleSnapshotPng(
  region: string,
  battleId: number,
  body: Buffer
): Promise<string> {
  const bucket = requireEnv("R2_BUCKET_NAME");
  const digest = pngDigest(body);
  const key = battleSnapshotObjectKey(region, battleId, digest);
  await r2Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "image/png",
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
  return battleSnapshotPublicUrl(region, battleId, digest);
}
