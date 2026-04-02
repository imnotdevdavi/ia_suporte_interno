function normalizeWindowMs(windowMs) {
  const parsed = Number.parseInt(String(windowMs || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 60 * 1000;
}

function normalizeMax(max) {
  const parsed = Number.parseInt(String(max || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 10;
}

export function createRateLimiter(options = {}) {
  const name = String(options.name || 'default');
  const windowMs = normalizeWindowMs(options.windowMs);
  const max = normalizeMax(options.max);
  const message = String(options.message || 'Limite de requisições excedido.');
  const keyGenerator = typeof options.keyGenerator === 'function'
    ? options.keyGenerator
    : (req) => req.ip || req.socket?.remoteAddress || 'unknown';
  const store = new Map();
  let lastSweepAt = 0;

  function sweepExpiredBuckets(now) {
    if (now - lastSweepAt < windowMs) return;

    for (const [bucketKey, bucket] of store.entries()) {
      if (!bucket || bucket.resetAt <= now) {
        store.delete(bucketKey);
      }
    }

    lastSweepAt = now;
  }

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    sweepExpiredBuckets(now);

    const rawKey = String(keyGenerator(req) || 'unknown');
    const bucketKey = `${name}:${rawKey}`;
    const current = store.get(bucketKey);

    let bucket = current;
    if (!bucket || bucket.resetAt <= now) {
      bucket = {
        count: 0,
        resetAt: now + windowMs,
      };
    }

    bucket.count += 1;
    store.set(bucketKey, bucket);

    const remaining = Math.max(max - bucket.count, 0);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: message,
        retryAfterSeconds,
      });
    }

    return next();
  };
}
