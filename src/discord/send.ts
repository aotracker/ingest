const CHANNEL_GAP_MS = 1100;
const lastSend = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ~1 message/second per Discord channel. */
export async function enqueueChannelSend<T>(
  channelId: string,
  send: () => Promise<T>
): Promise<T> {
  const previous = lastSend.get(channelId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  lastSend.set(
    channelId,
    previous.catch(() => undefined).then(() => gate)
  );

  await previous.catch(() => undefined);
  try {
    await sleep(CHANNEL_GAP_MS);
    return await send();
  } finally {
    release();
  }
}
