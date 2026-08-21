/**
 * The OSTR consumer client the inbound path asks (plan §8.3, spec 08 §8.3).
 *
 * `@owlat/ostr-client` resolves a subject in a fixed order — in-process cache,
 * then the local signed snapshot, then a DNS query — and that order is a
 * PRIVACY rule, not a performance one: a query tells the aggregator, and every
 * resolver between, who is sending this instance mail, and over a working day
 * those queries are a readable map of its correspondents. The snapshot answers
 * the same question out of a file the instance already holds and leaks nothing.
 * This module is what puts the snapshot there, so the MX is not left running on
 * the fallback half of a design whose whole point is to avoid it.
 *
 * Three deliberate choices:
 *
 *   - THE SNAPSHOT LIVES IN MEMORY. No persistence adapter is configured, so a
 *     restart re-fetches instead of re-verifying a file. The scored set is a
 *     public, re-fetchable artefact and the MTA is already the process that
 *     re-reads its whole world on boot; a durable copy would buy a few seconds
 *     of cold start in exchange for a second trust boundary to defend.
 *   - DIFFS ARE REFUSED. The v1 diff feed carries no signature, so anything
 *     able to answer `/v1/diff` could move a subject between tiers with no key
 *     at all. `SnapshotStore` refuses them unless explicitly opted in, and this
 *     module does not opt in. Freshness between snapshots comes from the DNS
 *     fallback, which is at least DNSSEC-signed by the aggregator's zone.
 *   - THE REFRESH IS UNREF'D AND STOPPABLE. The timer never holds the process
 *     open, and `stop()` is called when the listener closes, so a test that
 *     builds a server does not leave an hourly fetch behind it.
 *
 * With no aggregator configured the client still runs — zone-only, DNS-only —
 * and `refresh()` is a no-op. That configuration is supported and documented
 * (`.env.example`), but it is the leaking one; the pair of aggregator settings
 * is what turns it off.
 */

import { OstrClient, type FetchJson, type ResolveTxt } from '@owlat/ostr-client';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';

/** The config slice the consumer reads. */
export type OstrConsumerConfig = Pick<
	MtaConfig,
	'ostrEnabled' | 'ostrZone' | 'ostrAggregatorUrl' | 'ostrAggregatorPublicKey'
>;

/**
 * How often the signed snapshot is re-fetched. The reference aggregator
 * recomputes hourly (spec 08 §8.1: "TTLs around one hour for hot entries"), so
 * asking more often would mostly re-download an unchanged file; asking less
 * often would leave the DNS fallback answering for subjects the snapshot could
 * have covered.
 */
export const OSTR_SNAPSHOT_REFRESH_MS = 60 * 60 * 1000;

/**
 * Ceiling on a snapshot response, enforced while reading rather than after.
 * The signature is checked only once the document is parsed, so the bytes
 * before that point are unauthenticated input from the network and an
 * unbounded read would be an OOM anyone who can answer the URL could trigger.
 */
export const OSTR_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/** Whole-response deadline for a snapshot fetch. Nothing waits on this. */
const OSTR_SNAPSHOT_FETCH_TIMEOUT_MS = 30_000;

/** The client plus its refresh lifecycle. */
export interface OstrConsumer {
	/** The facade `ostrLookup.ts` resolves subjects through. */
	readonly client: OstrClient;
	/** Fetch, verify and adopt the current snapshot. Never rejects. */
	refresh(): Promise<void>;
	/** Start the periodic refresh (and do one now). Idempotent. */
	start(): void;
	/** Stop the periodic refresh. Idempotent. */
	stop(): void;
}

/** Test seams for {@link createAggregatorFetchJson}; production passes none. */
export interface AggregatorFetchOptions {
	readonly fetchImpl?: typeof fetch;
	readonly maxBytes?: number;
}

/**
 * Build a `fetchJson` for one aggregator base URL: absolute path in, decoded
 * JSON out, bounded in both time and bytes.
 */
export function createAggregatorFetchJson(
	baseUrl: string,
	options: AggregatorFetchOptions = {}
): FetchJson {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const maxBytes = options.maxBytes ?? OSTR_MAX_SNAPSHOT_BYTES;
	return async (path: string): Promise<unknown> => {
		const url = new URL(path, baseUrl);
		const response = await fetchImpl(url, {
			signal: AbortSignal.timeout(OSTR_SNAPSHOT_FETCH_TIMEOUT_MS),
			headers: { accept: 'application/json' },
			redirect: 'error',
		});
		if (!response.ok) {
			throw new Error(`aggregator ${path} responded ${String(response.status)}`);
		}
		return JSON.parse(await readCapped(response, maxBytes));
	};
}

/** Read a response body as UTF-8, refusing past `maxBytes` mid-stream. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new Error(`aggregator response declares ${String(declared)} bytes (cap ${maxBytes})`);
	}
	const body = response.body;
	if (body === null) {
		return '';
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			throw new Error(`aggregator response exceeded ${String(maxBytes)} bytes`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/** What {@link createOstrConsumer} needs from the world around it. */
export interface OstrConsumerDeps {
	/** Cached TXT resolver for the DNS fallback — `authResolvers.ostrTxt`. */
	readonly resolveTxt: ResolveTxt;
	/** Aggregator transport. Defaults to HTTPS against `ostrAggregatorUrl`. */
	readonly fetchJson?: FetchJson;
	/** Epoch SECONDS. The client never reads a clock of its own. */
	readonly now?: () => number;
}

/**
 * Build the consumer, or `null` when this instance consumes no registry.
 *
 * `null` is the whole of rule 1 in `ostrLookup.ts`: with `OSTR_ENABLED` off
 * there is no client to ask, so no code path can accidentally issue a lookup.
 */
export function createOstrConsumer(
	config: OstrConsumerConfig,
	deps: OstrConsumerDeps
): OstrConsumer | null {
	if (!config.ostrEnabled) {
		return null;
	}
	const aggregatorUrl = config.ostrAggregatorUrl;
	const publicKey = config.ostrAggregatorPublicKey;
	// `loadConfig` refuses a URL without a key, so one present implies the other;
	// this narrows for the compiler rather than re-deciding the rule.
	const aggregator =
		aggregatorUrl !== undefined && publicKey !== undefined
			? { fetchJson: deps.fetchJson ?? createAggregatorFetchJson(aggregatorUrl), publicKey }
			: undefined;
	const client = new OstrClient({
		...(config.ostrZone === undefined ? {} : { zone: config.ostrZone }),
		...(aggregator === undefined ? {} : { aggregator }),
		resolveTxt: deps.resolveTxt,
		now: deps.now ?? (() => Math.floor(Date.now() / 1000)),
	});

	let timer: ReturnType<typeof setInterval> | undefined;
	const refresh = async (): Promise<void> => {
		if (aggregator === undefined) {
			return;
		}
		try {
			const result = await client.syncSnapshot();
			if (result.ok) {
				logger.info(
					{ entries: result.entries, asOf: result.asOf },
					'OSTR snapshot adopted — lookups answer locally'
				);
			} else {
				// The previous scored set is kept; the DNS fallback covers the rest.
				logger.warn({ errors: result.errors }, 'OSTR snapshot sync refused');
			}
		} catch (err) {
			logger.warn({ err }, 'OSTR snapshot sync failed');
		}
	};

	return {
		client,
		refresh,
		start: () => {
			if (timer !== undefined || aggregator === undefined) {
				return;
			}
			void refresh();
			timer = setInterval(() => void refresh(), OSTR_SNAPSHOT_REFRESH_MS);
			// A reputation refresh is never a reason to keep the process alive.
			timer.unref();
		},
		stop: () => {
			if (timer === undefined) {
				return;
			}
			clearInterval(timer);
			timer = undefined;
		},
	};
}
