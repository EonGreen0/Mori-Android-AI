const DEVICE_ID_KEY = "mori_sync_device_id_v1";

function createDeviceId() {
  if (globalThis.crypto?.randomUUID) return `device_${globalThis.crypto.randomUUID()}`;
  return `device_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function getOrCreateSyncDeviceId(storage = globalThis.localStorage) {
  if (!storage) return createDeviceId();
  try {
    const existing = String(storage.getItem(DEVICE_ID_KEY) || "").trim();
    if (existing) return existing;
    const id = createDeviceId();
    storage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch (_) {
    return createDeviceId();
  }
}
