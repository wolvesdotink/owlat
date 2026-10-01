/**
 * Delivery log indexes and bounded stream scans.
 *
 * Every event is appended to the day's audit stream (`mta:delivery-log:<date>`)
 * by one Lua script that, in the same atomic step, maintains three small
 * per-day indexes:
 *
 * - `{mta:delivery-log:<date>}:stats` — status counts for the whole day, plus
 *   `total`, the number of stream entries this script has indexed.
 * - `{mta:delivery-log:<date>}:org:<orgId>` — the same counts for one
 *   organization.
 * - `{mta:delivery-log:<date>}:msg` — messageId -> space-separated stream IDs,
 *   for the first `DELIVERY_LOG_MAX_LEN` entries of the day only. The day
 *   stats hash counts them in `msgIndexed`; once the day's total reaches the
 *   stream's MAXLEN the script stops adding to it, so the message index never
 *   holds more IDs than the stream can retain (about 106 B per entry, ~10.6 MB
 *   per day at the default 100,000).
 *
 * The hash tag equals the stream key, so all four keys share one Redis Cluster
 * slot. Index keys inherit the stream's expiry, so they disappear together.
 *
 * Retention: the script trims the stream itself, exactly, to
 * `DELIVERY_LOG_MAX_LEN` entries (oldest first, at most
 * `EVICTION_BATCH` per write), and for every entry it removes adds one to
 * `evicted:<status>` and `evicted:total` in the day hash and in that entry's
 * organization hash. Retained counts are then `<status> - evicted:<status>`,
 * so statistics stay "retained audit entries" on a day that passed the cap.
 * The added counts and `total` only ever grow.
 *
 * The indexes are an accelerator, never a second source of truth. The stream's
 * own `entries-added` counter (XINFO STREAM, Redis 7+) says how many entries
 * were ever appended; when it equals the indexed `total`, every entry went
 * through the script. Readers only trust the indexes when that holds:
 *
 * - statistics additionally need `length == entries-added - evicted:total`:
 *   every entry that left the stream left through the script, which counted
 *   it. Any other removal (XDEL, XTRIM, an older MTA's `MAXLEN ~` trim) makes
 *   the day shorter than that and sends it to the scan;
 * - message histories tolerate trimming, because they resolve every indexed ID
 *   against the stream and skip the ones it no longer holds, but need
 *   `msgIndexed == total`: a day past the message-index cap is scanned, which
 *   MAXLEN bounds to about the same number of entries.
 *
 * Anything else (older Redis, days written by an older MTA, an interrupted
 * write, a day trimmed outside the script) falls back to `scanDeliveryStream`,
 * which pages the stream with exclusive boundaries and stops on no progress.
 */

import type Redis from 'ioredis';

export const DELIVERY_LOG_PREFIX = 'mta:delivery-log:';

export const streamKeyFor = (date: string): string => `${DELIVERY_LOG_PREFIX}${date}`;
export const statsKeyFor = (date: string): string => `{${streamKeyFor(date)}}:stats`;
export const orgStatsKeyFor = (date: string, orgId: string): string =>
	`{${streamKeyFor(date)}}:org:${orgId}`;
export const messageIndexKeyFor = (date: string): string => `{${streamKeyFor(date)}}:msg`;

/** Field in both stats hashes counting indexed entries; also the coverage counter. */
export const INDEXED_TOTAL_FIELD = 'total';
/** Field in the day stats hash counting entries added to the message index. Not a status. */
export const MESSAGE_INDEXED_FIELD = 'msgIndexed';
/** Prefix of the fields counting entries the script trimmed: `evicted:<status>`, `evicted:total`. */
export const EVICTED_FIELD_PREFIX = 'evicted:';
export const EVICTED_TOTAL_FIELD = `${EVICTED_FIELD_PREFIX}${INDEXED_TOTAL_FIELD}`;
/**
 * Most entries one write trims. Steady state trims one; a lowered
 * `DELIVERY_LOG_MAX_LEN` shrinks the day by this many minus one per write
 * instead of blocking Redis on one large trim.
 */
export const EVICTION_BATCH = 64;

/**
 * KEYS: stream, day stats, org stats, message index.
 * ARGV: maxLen, ttlMs, status, messageId, then the XADD field/value pairs.
 *
 * The day `total` is incremented last: if any earlier call fails, the stream
 * holds an entry the indexes do not fully cover, `entries-added` exceeds
 * `total`, and readers fall back to scanning that day. A failure inside the
 * eviction leaves `length` and `evicted:total` out of step, which sends
 * statistics to the scan the same way.
 *
 * Evicted entries can belong to any organization, so their org hash is named
 * here from the stream key rather than passed in KEYS; it carries the same
 * hash tag, so it lives in the stream's Redis Cluster slot. An org hash first
 * created by an eviction takes the stream's TTL like the others.
 *
 * The message index takes an entry only while the day's `total` is below
 * maxLen (see the module comment). A ttlMs of 0 or less expires the stream at
 * once, as it always did, and then writes no indexes, so none outlive it.
 */
export const RECORD_DELIVERY_EVENT_SCRIPT = `
local maxLen = tonumber(ARGV[1])
local id = redis.call('XADD', KEYS[1], '*', unpack(ARGV, 5))
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -1 then
	redis.call('PEXPIRE', KEYS[1], ARGV[2])
	ttl = tonumber(ARGV[2])
end
if ttl <= 0 then return id end
if tonumber(redis.call('HGET', KEYS[2], 'total') or '0') < maxLen then
	local previous = redis.call('HGET', KEYS[4], ARGV[4])
	if previous then
		redis.call('HSET', KEYS[4], ARGV[4], previous .. ' ' .. id)
	else
		redis.call('HSET', KEYS[4], ARGV[4], id)
	end
	redis.call('HINCRBY', KEYS[2], 'msgIndexed', 1)
end
redis.call('HINCRBY', KEYS[3], ARGV[3], 1)
redis.call('HINCRBY', KEYS[3], 'total', 1)
redis.call('HINCRBY', KEYS[2], ARGV[3], 1)
for i = 2, 4 do
	if redis.call('PTTL', KEYS[i]) == -1 then redis.call('PEXPIRE', KEYS[i], ttl) end
end
local excess = redis.call('XLEN', KEYS[1]) - maxLen
if excess > 0 then
	if excess > ${EVICTION_BATCH} then excess = ${EVICTION_BATCH} end
	local orgPrefix = '{' .. KEYS[1] .. '}:org:'
	for _, entry in ipairs(redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', excess)) do
		local fields = entry[2]
		local orgId, status = '', 'failed'
		for f = 1, #fields, 2 do
			if fields[f] == 'orgId' then orgId = fields[f + 1] end
			if fields[f] == 'status' then status = fields[f + 1] end
		end
		local orgKey = orgPrefix .. orgId
		redis.call('HINCRBY', orgKey, 'evicted:' .. status, 1)
		redis.call('HINCRBY', orgKey, 'evicted:total', 1)
		if redis.call('PTTL', orgKey) == -1 then redis.call('PEXPIRE', orgKey, ttl) end
		redis.call('HINCRBY', KEYS[2], 'evicted:' .. status, 1)
		redis.call('HINCRBY', KEYS[2], 'evicted:total', 1)
		redis.call('XDEL', KEYS[1], entry[1])
	end
end
redis.call('HINCRBY', KEYS[2], 'total', 1)
return id
`;

export type StreamEntry = [id: string, fields: string[]];

/** State of one day's stream, read atomically with its index counter. */
export type DayCoverage =
	| { kind: 'absent' }
	| { kind: 'unknown' }
	| {
			kind: 'known';
			length: number;
			entriesAdded: number;
			indexedTotal: number;
			messageIndexed: number;
			/** Entries the script trimmed and subtracted from the counts. */
			evicted: number;
	  };

type ExecResult = Array<[Error | null, unknown]> | null;

function parseStreamInfo(reply: unknown): { length: number; entriesAdded?: number } | undefined {
	if (!Array.isArray(reply)) return undefined;
	let length: number | undefined;
	let entriesAdded: number | undefined;
	for (let i = 0; i + 1 < reply.length; i += 2) {
		if (reply[i] === 'length') length = Number(reply[i + 1]);
		if (reply[i] === 'entries-added') entriesAdded = Number(reply[i + 1]);
	}
	return length === undefined ? undefined : { length, entriesAdded };
}

/**
 * Read a day's coverage plus one index value in a single MULTI, so the counters
 * and the indexed value describe the same instant. Any failure (no XINFO in
 * the client, Redis < 7 without `entries-added`, a transport error) reports
 * `unknown`, which callers treat as "scan the stream".
 */
export async function readDayIndex(
	redis: Redis,
	date: string,
	read: 'stats' | 'org' | 'message',
	arg?: string
): Promise<{ coverage: DayCoverage; value: unknown }> {
	let result: ExecResult;
	try {
		const tx = redis
			.multi()
			.xinfo('STREAM', streamKeyFor(date))
			.hmget(statsKeyFor(date), INDEXED_TOTAL_FIELD, MESSAGE_INDEXED_FIELD, EVICTED_TOTAL_FIELD);
		if (read === 'stats') tx.hgetall(statsKeyFor(date));
		else if (read === 'org') tx.hgetall(orgStatsKeyFor(date, arg ?? ''));
		else tx.hget(messageIndexKeyFor(date), arg ?? '');
		result = (await tx.exec()) as ExecResult;
	} catch {
		return { coverage: { kind: 'unknown' }, value: undefined };
	}
	if (!result || result.length !== 3) return { coverage: { kind: 'unknown' }, value: undefined };
	const [[infoErr, info], [totalErr, totals], [valueErr, value]] = result as [
		[Error | null, unknown],
		[Error | null, unknown],
		[Error | null, unknown],
	];
	if (infoErr) {
		return {
			coverage: /no such key/i.test(infoErr.message) ? { kind: 'absent' } : { kind: 'unknown' },
			value: undefined,
		};
	}
	const parsed = parseStreamInfo(info);
	if (!parsed || parsed.entriesAdded === undefined || totalErr || valueErr) {
		return { coverage: { kind: 'unknown' }, value: undefined };
	}
	const [total, messageIndexed, evicted] = Array.isArray(totals) ? totals : [];
	return {
		coverage: {
			kind: 'known',
			length: parsed.length,
			entriesAdded: parsed.entriesAdded,
			indexedTotal: Number(total ?? 0),
			messageIndexed: Number(messageIndexed ?? 0),
			evicted: Number(evicted ?? 0),
		},
		value,
	};
}

/** Every entry ever appended went through the index script. */
export function indexCoversAllWrites(coverage: DayCoverage): boolean {
	return coverage.kind === 'known' && coverage.entriesAdded === coverage.indexedTotal;
}

/** The message index holds every entry ever appended (the day stayed below the cap). */
export function messageIndexCoversAllWrites(coverage: DayCoverage): boolean {
	return (
		indexCoversAllWrites(coverage) &&
		coverage.kind === 'known' &&
		coverage.messageIndexed === coverage.indexedTotal
	);
}

/**
 * The counters describe exactly the retained stream: every entry was indexed,
 * and every entry that left the stream was trimmed and counted by the script.
 */
export function indexMatchesRetainedStream(coverage: DayCoverage): boolean {
	return (
		indexCoversAllWrites(coverage) &&
		coverage.kind === 'known' &&
		coverage.length === coverage.entriesAdded - coverage.evicted
	);
}

/**
 * Retained status counts from a day or organization hash: added minus evicted
 * per status, `total` included. Bookkeeping fields are dropped, and so is a
 * status outside `into`'s defaults that has no retained entry left, matching
 * what a scan of the retained stream reports.
 */
export function retainedCounts(
	hash: Record<string, string>,
	into: Record<string, number>
): Record<string, number> {
	const counts: Record<string, number> = { ...into };
	for (const [field, value] of Object.entries(hash)) {
		if (field === MESSAGE_INDEXED_FIELD) continue;
		const evicted = field.startsWith(EVICTED_FIELD_PREFIX);
		const status = evicted ? field.slice(EVICTED_FIELD_PREFIX.length) : field;
		counts[status] = (counts[status] ?? 0) + (evicted ? -Number(value) : Number(value));
	}
	for (const [status, count] of Object.entries(counts)) {
		if (!(status in into) && count === 0) delete counts[status];
	}
	return counts;
}

function parseStreamId(id: string): [bigint, bigint] {
	const dash = id.indexOf('-');
	if (dash < 0) return [BigInt(id), 0n];
	return [BigInt(id.slice(0, dash)), BigInt(id.slice(dash + 1))];
}

const MAX_SEQUENCE = (1n << 64n) - 1n;

/** The smallest stream ID strictly greater than `id` — an exclusive lower bound that works on any Redis version. */
export function nextStreamId(id: string): string {
	const [ms, seq] = parseStreamId(id);
	return seq >= MAX_SEQUENCE ? `${ms + 1n}-0` : `${ms}-${seq + 1n}`;
}

/** The largest stream ID strictly less than `id`, floored at `0-0` (which no entry can have). */
export function previousStreamId(id: string): string {
	const [ms, seq] = parseStreamId(id);
	if (seq > 0n) return `${ms}-${seq - 1n}`;
	return ms > 0n ? `${ms - 1n}-${MAX_SEQUENCE}` : '0-0';
}

export function compareStreamIds(a: string, b: string): number {
	const [am, as] = parseStreamId(a);
	const [bm, bs] = parseStreamId(b);
	if (am !== bm) return am < bm ? -1 : 1;
	if (as !== bs) return as < bs ? -1 : 1;
	return 0;
}

/**
 * Visit every entry of a stream once, oldest first, `pageSize` at a time.
 *
 * The cursor advances past the last entry *examined* — never only past the
 * last one a filter kept — and each page starts strictly after it, so a page
 * boundary is read once. A page that does not move forward throws instead of
 * rereading forever.
 */
export async function scanDeliveryStream(
	redis: Redis,
	streamKey: string,
	pageSize: number,
	visit: (id: string, fields: string[]) => void
): Promise<void> {
	let start = '-';
	let last: string | undefined;
	for (;;) {
		const page = (await redis.xrange(streamKey, start, '+', 'COUNT', pageSize)) as StreamEntry[];
		for (const [id, fields] of page) {
			if (last !== undefined && compareStreamIds(id, last) <= 0) {
				throw new Error(`Delivery log scan made no progress at ${id} in ${streamKey}`);
			}
			last = id;
			visit(id, fields);
		}
		if (page.length < pageSize || last === undefined) return;
		start = nextStreamId(last);
	}
}
