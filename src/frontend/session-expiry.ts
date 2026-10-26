interface ExpiryEnvironment {
  clock(): number;
  later(callback: () => void, delay: number): () => void;
  onVisibility(callback: () => void): () => void;
}
export interface SessionExpiry {
  expiresAt: number;
  serverTime?: number;
}

/** Catch expiry even when a quiet socket receives only automatic keepalives. */
export function watchSessionExpiry(
  expiry: SessionExpiry,
  onExpired: () => void,
  env: ExpiryEnvironment = {
    clock: () => Date.now(),
    later: (callback, delay) => {
      const timer = window.setTimeout(callback, delay);
      return () => window.clearTimeout(timer);
    },
    onVisibility: (callback) => {
      document.addEventListener("visibilitychange", callback);
      return () => document.removeEventListener("visibilitychange", callback);
    },
  },
) {
  // Correct initial browser clock skew using the instance's response time.
  const offset = expiry.serverTime === undefined ? 0 : expiry.serverTime - env.clock();
  let stopped = false;
  let cancelTimer = () => {};
  let cancelVisibility = () => {};
  function stop() {
    stopped = true;
    cancelTimer();
    cancelVisibility();
  }
  function check() {
    if (stopped) return;
    cancelTimer();
    const remaining = expiry.expiresAt - (env.clock() + offset);
    if (remaining <= 0) {
      stop();
      onExpired();
    } else {
      // Session lifetimes can exceed the browser's signed 32-bit timer range.
      cancelTimer = env.later(check, Math.min(remaining, 2_147_483_647));
    }
  }
  cancelVisibility = env.onVisibility(check);
  check();
  return stop;
}
