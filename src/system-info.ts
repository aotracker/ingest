import os from "node:os";
import { statfs } from "node:fs/promises";
import { checkRedisWritable } from "./jobs/connection";

export type MemoryInfo = {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  systemTotalBytes: number;
  systemFreeBytes: number;
};

export type CpuInfo = {
  cores: number;
  model: string;
  loadAvg1m: number;
  loadAvg5m: number;
  loadAvg15m: number;
};

export type DiskInfo = {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
};

export type RuntimeSystemInfo = {
  hostname: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  uptimeSeconds: number;
  memory: MemoryInfo;
  cpu: CpuInfo;
  disk: DiskInfo | null;
};

export type ServiceStatus = {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
};

export function collectRuntimeSystemInfo(): RuntimeSystemInfo {
  const mem = process.memoryUsage();
  const cpus = os.cpus();
  const [load1, load5, load15] = os.loadavg();

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      systemTotalBytes: os.totalmem(),
      systemFreeBytes: os.freemem(),
    },
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model ?? "unknown",
      loadAvg1m: load1,
      loadAvg5m: load5,
      loadAvg15m: load15,
    },
    disk: null,
  };
}

export async function collectDiskInfo(mount = "/"): Promise<DiskInfo | null> {
  try {
    const stats = await statfs(mount);
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bfree;
    const usedBytes = totalBytes - freeBytes;
    const usagePercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    return { mount, totalBytes, usedBytes, freeBytes, usagePercent };
  } catch {
    return null;
  }
}

export async function pingRedis(): Promise<ServiceStatus> {
  return checkRedisWritable();
}

export async function collectFullSystemInfo(): Promise<RuntimeSystemInfo> {
  const runtime = collectRuntimeSystemInfo();
  runtime.disk = await collectDiskInfo();
  return runtime;
}
