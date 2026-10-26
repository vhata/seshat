/**
 * Per-client fixed windows in the single instance object. No anonymous attempt
 * writes durable rows. Eviction/restart resets this best-effort abuse limit;
 * it cannot guarantee the App's budget against distributed clients.
 */
export const CALLBACK_WINDOW_MS = 10 * 60 * 1000;
export const CALLBACK_ATTEMPTS = 10;
export const CALLBACK_CLIENTS = 4096;

export class CallbackLimiter {
  private readonly clients = new Map<string, { attempts: number; until: number }>();

  /** Seconds to wait, or zero when this attempt may reach GitHub. */
  attempt(client: string, now: number): number {
    for (const [key, entry] of this.clients) {
      if (entry.until <= now) this.clients.delete(key);
    }
    const entry = this.clients.get(client);
    if (entry) {
      if (entry.attempts >= CALLBACK_ATTEMPTS) return Math.ceil((entry.until - now) / 1000);
      entry.attempts++;
      return 0;
    }
    // Never evict live counters: client churn must not reset an abuser's cap.
    // Existing clients keep their allowance if anonymous identities fill it.
    if (this.clients.size >= CALLBACK_CLIENTS) {
      let earliest = Infinity;
      for (const entry of this.clients.values()) earliest = Math.min(earliest, entry.until);
      return Math.ceil((earliest - now) / 1000);
    }
    this.clients.set(client, { attempts: 1, until: now + CALLBACK_WINDOW_MS });
    return 0;
  }
}
