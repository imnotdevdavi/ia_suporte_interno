function normalizePositiveNumber(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createAsyncExpiringCache(options = {}) {
  const ttlMs = normalizePositiveNumber(options.ttlMs, 60 * 1000);
  const maxEntries = normalizePositiveNumber(options.maxEntries, 100);
  const store = new Map();
  const inflight = new Map();

  function deleteExpiredEntries(now = Date.now()) {
    for (const [key, entry] of store.entries()) {
      if (!entry || entry.expiresAt <= now) {
        store.delete(key);
      }
    }
  }

  function trimOverflow() {
    while (store.size > maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) return;
      store.delete(oldestKey);
    }
  }

  function getCachedEntry(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }

    return entry.value;
  }

  function setCachedEntry(key, value) {
    store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
    trimOverflow();
  }

  async function getOrLoad(key, loader) {
    deleteExpiredEntries();

    const cached = getCachedEntry(key);
    if (cached !== null) {
      return { value: cached, source: 'cache' };
    }

    const existingPromise = inflight.get(key);
    if (existingPromise) {
      return { value: await existingPromise, source: 'inflight' };
    }

    const pending = (async () => {
      const value = await loader();
      setCachedEntry(key, value);
      return value;
    })().finally(() => {
      inflight.delete(key);
    });

    inflight.set(key, pending);
    return { value: await pending, source: 'loader' };
  }

  return {
    getOrLoad,
    clear() {
      store.clear();
      inflight.clear();
    },
  };
}
