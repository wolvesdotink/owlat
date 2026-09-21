/**
 * A small TTL cache with an injected clock.
 *
 * `now()` is a constructor argument because this package may not read the
 * system clock: a receiver's cache expiry is part of what its tests assert, and
 * a fake clock is the only way to assert it without sleeping. The size bound is
 * not decoration either — the keys are sender identities, and an MTA under a
 * dictionary attack would otherwise grow one entry per name it is offered.
 */

interface CacheSlot<T> {
	value: T;
	expiresAt: number;
}

export interface TtlCacheOptions {
	/** Epoch seconds. */
	now: () => number;
	ttlSeconds: number;
	/** Oldest-inserted entries are evicted past this. */
	maxEntries?: number;
}

export const DEFAULT_MAX_CACHE_ENTRIES = 10_000;

export class TtlCache<T> {
	private readonly slots = new Map<string, CacheSlot<T>>();
	private readonly now: () => number;
	private readonly ttlSeconds: number;
	private readonly maxEntries: number;

	constructor(options: TtlCacheOptions) {
		this.now = options.now;
		this.ttlSeconds = options.ttlSeconds;
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
	}

	get(key: string): T | null {
		const slot = this.slots.get(key);
		if (slot === undefined) return null;
		if (slot.expiresAt <= this.now()) {
			this.slots.delete(key);
			return null;
		}
		return slot.value;
	}

	/**
	 * Hold `value` for `ttlSeconds`, or for `ttlOverrideSeconds` when the
	 * caller knows a shorter life — a DNS record's own TTL, which spec 08 §8.1
	 * forbids pinning past. The configured TTL is a ceiling, never a floor.
	 */
	set(key: string, value: T, ttlOverrideSeconds?: number): void {
		const ttl =
			ttlOverrideSeconds === undefined
				? this.ttlSeconds
				: Math.min(this.ttlSeconds, Math.floor(ttlOverrideSeconds));
		if (ttl <= 0) return;
		// Re-inserting moves the key to the end of the eviction order, which is
		// what makes the oldest key the oldest *write*, not the oldest name.
		this.slots.delete(key);
		this.slots.set(key, { value, expiresAt: this.now() + ttl });
		while (this.slots.size > this.maxEntries) {
			const oldest = this.slots.keys().next();
			if (oldest.done === true) break;
			this.slots.delete(oldest.value);
		}
	}

	delete(key: string): void {
		this.slots.delete(key);
	}

	clear(): void {
		this.slots.clear();
	}

	/** Entries held, expired ones included — they are dropped lazily on read. */
	size(): number {
		return this.slots.size;
	}
}
