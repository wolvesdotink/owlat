/**
 * An in-memory Redis double for the delivery log readers, faithful where
 * ioredis-mock is not: XRANGE honours explicit start/end IDs and COUNT, XINFO
 * STREAM reports `length` and `entries-added`, and MULTI answers per-command
 * errors the way EXEC does. Every command is counted, so tests can bound the
 * work a read does rather than only its result.
 *
 * Writes go through `recordIndexed` (what the record script does, step by step,
 * including its exact MAXLEN trim) or `recordUnindexed` (what an MTA without
 * the indexes did: XADD only). `trim` models a removal outside the script.
 */

import type Redis from 'ioredis';
import {
	EVICTED_FIELD_PREFIX,
	EVICTED_TOTAL_FIELD,
	EVICTION_BATCH,
	INDEXED_TOTAL_FIELD,
	MESSAGE_INDEXED_FIELD,
	compareStreamIds,
	messageIndexKeyFor,
	orgStatsKeyFor,
	statsKeyFor,
	streamKeyFor,
	type StreamEntry,
} from '../../monitoring/deliveryLogIndex.js';

export interface FakeEvent {
	messageId: string;
	orgId: string;
	status: string;
}

type Reply = [Error | null, unknown];

export class DeliveryLogRedisFake {
	readonly calls: Record<string, number> = {};
	entriesReturned = 0;
	private readonly streams = new Map<string, StreamEntry[]>();
	private readonly added = new Map<string, number>();
	private readonly hashes = new Map<string, Map<string, string>>();
	private clock = 1_700_000_000_000;
	private sequence = 0;
	/**
	 * The record script's maxLen argument: the message index stops at this many
	 * day entries, and the stream is trimmed to it.
	 */
	maxLen = Infinity;

	/** @param supportsXinfo false models a client/server without XINFO `entries-added` (Redis < 7). */
	constructor(private readonly supportsXinfo = true) {}

	asRedis(): Redis {
		return this as unknown as Redis;
	}

	private count(name: string): void {
		this.calls[name] = (this.calls[name] ?? 0) + 1;
	}

	/** Total commands sent, MULTI/EXEC included. */
	get commands(): number {
		return Object.values(this.calls).reduce((sum, n) => sum + n, 0);
	}

	resetCounts(): void {
		for (const key of Object.keys(this.calls)) delete this.calls[key];
		this.entriesReturned = 0;
	}

	/** Entries currently in a day's stream. */
	length(date: string): number {
		return this.streams.get(streamKeyFor(date))?.length ?? 0;
	}

	private append(date: string, event: FakeEvent): string {
		// Three entries per millisecond, so sequence numbers above zero appear
		// at page boundaries too.
		const id = `${this.clock + Math.floor(this.sequence / 3)}-${this.sequence % 3}`;
		this.sequence += 1;
		const key = streamKeyFor(date);
		const stream = this.streams.get(key) ?? [];
		stream.push([
			id,
			[
				'messageId',
				event.messageId,
				'orgId',
				event.orgId,
				'status',
				event.status,
				'domain',
				'example.com',
			],
		]);
		this.streams.set(key, stream);
		this.added.set(key, (this.added.get(key) ?? 0) + 1);
		return id;
	}

	private hash(key: string): Map<string, string> {
		const existing = this.hashes.get(key);
		if (existing) return existing;
		const created = new Map<string, string>();
		this.hashes.set(key, created);
		return created;
	}

	private hincr(key: string, field: string): void {
		const h = this.hash(key);
		h.set(field, String(Number(h.get(field) ?? 0) + 1));
	}

	/**
	 * Mirror RECORD_DELIVERY_EVENT_SCRIPT. `stopBeforeTotal` models a write that
	 * failed after the stream entry and part of the indexes were written.
	 */
	recordIndexed(date: string, event: FakeEvent, stopBeforeTotal = false): string {
		const id = this.append(date, event);
		const indexed = Number(this.hash(statsKeyFor(date)).get(INDEXED_TOTAL_FIELD) ?? 0);
		if (indexed < this.maxLen) {
			const msg = this.hash(messageIndexKeyFor(date));
			const previous = msg.get(event.messageId);
			msg.set(event.messageId, previous ? `${previous} ${id}` : id);
			this.hincr(statsKeyFor(date), MESSAGE_INDEXED_FIELD);
		}
		this.hincr(orgStatsKeyFor(date, event.orgId), event.status);
		this.hincr(orgStatsKeyFor(date, event.orgId), INDEXED_TOTAL_FIELD);
		this.hincr(statsKeyFor(date), event.status);
		const stream = this.streams.get(streamKeyFor(date))!;
		const excess = Math.min(stream.length - this.maxLen, EVICTION_BATCH);
		for (const [, fields] of excess > 0 ? stream.splice(0, excess) : []) {
			const field = (name: string) => {
				for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === name) return fields[i + 1];
				return undefined;
			};
			const status = `${EVICTED_FIELD_PREFIX}${field('status') ?? 'failed'}`;
			for (const key of [orgStatsKeyFor(date, field('orgId') ?? ''), statsKeyFor(date)]) {
				this.hincr(key, status);
				this.hincr(key, EVICTED_TOTAL_FIELD);
			}
		}
		if (!stopBeforeTotal) this.hincr(statsKeyFor(date), INDEXED_TOTAL_FIELD);
		return id;
	}

	recordUnindexed(date: string, event: FakeEvent): string {
		return this.append(date, event);
	}

	/** XTRIM MAXLEN: drop the oldest entries; `entries-added` is unchanged. */
	trim(date: string, keep: number): void {
		const stream = this.streams.get(streamKeyFor(date)) ?? [];
		this.streams.set(streamKeyFor(date), stream.slice(Math.max(0, stream.length - keep)));
	}

	async xrange(key: string, start: string, end: string, ...args: (string | number)[]) {
		this.count('xrange');
		return this.range(key, start, end, args);
	}

	private range(key: string, start: string, end: string, args: (string | number)[]): StreamEntry[] {
		const countAt = args.findIndex((a) => String(a).toUpperCase() === 'COUNT');
		const limit = countAt >= 0 ? Number(args[countAt + 1]) : Infinity;
		const out: StreamEntry[] = [];
		for (const entry of this.streams.get(key) ?? []) {
			if (out.length >= limit) break;
			if (start !== '-' && compareStreamIds(entry[0], start) < 0) continue;
			if (end !== '+' && compareStreamIds(entry[0], end) > 0) break;
			out.push(entry);
		}
		this.entriesReturned += out.length;
		return out;
	}

	multi() {
		this.count('multi');
		if (!this.supportsXinfo) throw new Error('Unsupported command: "xinfo"');
		const queued: Array<() => Reply> = [];
		const tx = {
			xinfo: (_sub: string, key: string) => {
				queued.push(() => {
					this.count('xinfo');
					const stream = this.streams.get(key);
					if (!stream) return [new Error('ERR no such key'), null];
					return [null, ['length', stream.length, 'entries-added', this.added.get(key) ?? 0]];
				});
				return tx;
			},
			hget: (key: string, field: string) => {
				queued.push(() => {
					this.count('hget');
					return [null, this.hashes.get(key)?.get(field) ?? null];
				});
				return tx;
			},
			hmget: (key: string, ...fields: string[]) => {
				queued.push(() => {
					this.count('hmget');
					return [null, fields.map((f) => this.hashes.get(key)?.get(f) ?? null)];
				});
				return tx;
			},
			hgetall: (key: string) => {
				queued.push(() => {
					this.count('hgetall');
					return [null, Object.fromEntries(this.hashes.get(key) ?? [])];
				});
				return tx;
			},
			exec: async () => {
				this.count('exec');
				return queued.map((run) => run());
			},
		};
		return tx;
	}

	pipeline() {
		const queued: Array<() => Reply> = [];
		const p = {
			xrange: (key: string, start: string, end: string) => {
				queued.push(() => {
					this.count('xrange');
					return [null, this.range(key, start, end, [])];
				});
				return p;
			},
			exec: async () => queued.map((run) => run()),
		};
		return p;
	}
}
