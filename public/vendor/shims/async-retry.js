function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export default async function retry(fn, options) {
  var opts = options || {};
  var retries = Number.isInteger(opts.retries) && opts.retries >= 0 ? opts.retries : 10;
  var factor = typeof opts.factor === 'number' && opts.factor > 0 ? opts.factor : 2;
  var minTimeout = typeof opts.minTimeout === 'number' && opts.minTimeout >= 0 ? opts.minTimeout : 250;
  var maxTimeout = typeof opts.maxTimeout === 'number' && opts.maxTimeout >= minTimeout ? opts.maxTimeout : 2000;
  var randomize = opts.randomize !== false;
  var attempt = 0;
  var lastError = null;

  while (attempt <= retries) {
    var currentAttempt = attempt + 1;

    try {
      return await fn(function bail(error) {
        throw error || new Error('Aborted');
      }, currentAttempt);
    } catch (error) {
      lastError = error;

      if (attempt >= retries) {
        throw error;
      }

      if (typeof opts.onRetry === 'function') {
        opts.onRetry(error, currentAttempt);
      }

      var timeout = Math.min(
        maxTimeout,
        minTimeout * Math.pow(factor, attempt) * (randomize ? (1 + Math.random()) : 1)
      );

      await wait(timeout);
      attempt += 1;
    }
  }

  throw lastError || new Error('Retry failed');
}
