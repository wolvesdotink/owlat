/**
 * The transparency primitives monitors and auditors run against
 * (plan §9.1, spec 05 §5.4).
 *
 * These four endpoints are the whole reason a client never has to trust this
 * server: the head is signed, the proofs are verifiable against it with
 * `@owlat/ostr-core`'s `verifyInclusion`/`verifyConsistency`, and the entry
 * range lets a monitor rebuild the tree itself and check that the two agree.
 *
 * Parameter names follow spec 05 §5.4 exactly — `?hash=&size=` for an inclusion
 * proof, `?from=&to=` for a consistency proof — because a monitor written
 * against the specification and pointed at this node must work. The earlier
 * spellings `?index=` and `?old=&new=` are still accepted: `index` as the local
 * convenience form (a caller that just read `/v1/log/entries` has the index and
 * not the hash), `old`/`new` as deprecated aliases.
 *
 * Coordinates are bounded against the log *before* the log is asked, against
 * `log.size()`. That is not defensive duplication: `@owlat/ostr-core`'s
 * MerkleTree signals an out-of-range coordinate with a `RangeError`, and a
 * `RangeError` is not distinguishable from V8's own (`Maximum call stack size
 * exceeded`), so the HTTP layer must not translate one into a 400 — it has to
 * know the request was out of range before making it (see `errors.ts`).
 */
import type { Hono } from 'hono';
import type { RegistryLog } from '../../contracts.js';
import { CACHE_ANSWER, CACHE_IMMUTABLE, CACHE_NONE } from '../cache.js';
import { badRequest, notFound, notImplemented } from '../errors.js';
import {
	MAX_PAGE_LIMIT,
	optionalHash,
	optionalInteger,
	requireAliasedInteger,
	requireInteger,
	singleQuery,
} from '../params.js';

/**
 * Leaf hash (lowercase hex) to leaf index, or null when this log has no such
 * leaf.
 *
 * This is a seam, not a service: the frozen {@link RegistryLog} contract has no
 * hash lookup, and spec 05 §5.4 keys inclusion proofs by hash — a submitter
 * holds a signed inclusion promise, which carries `leafHash` and no index at
 * all. The composition root injects the lookup (the store already indexes the
 * leaf it dedupes on), and without it the `?hash=` form answers 501 rather than
 * a linear scan of the tree on an anonymous request.
 */
export type LeafIndexLookup = (leafHashHex: string) => Promise<number | null>;

export interface LogRouteDeps {
	log: RegistryLog;
	leafIndex?: LeafIndexLookup;
}

/** Bound a caller-supplied tree size against what this log can actually prove. */
async function requireWithinTree(log: RegistryLog, name: string, size: number): Promise<void> {
	const treeSize = await log.size();
	if (size > treeSize) {
		throw badRequest(`${name} must be at most the log's current tree size (${treeSize})`);
	}
}

async function indexOfLeafHash(deps: LogRouteDeps, hash: string): Promise<number> {
	if (deps.leafIndex === undefined) {
		throw notImplemented('lookup by leaf hash is not enabled on this node; use index');
	}
	const index = await deps.leafIndex(hash);
	if (index === null) throw notFound('no leaf with that hash');
	return index;
}

export function registerLogRoutes(app: Hono, deps: LogRouteDeps): void {
	const { log } = deps;

	app.get('/v1/log/sth', async (c) => {
		const head = await log.head();
		if (head === null) throw notFound('no tree head published yet');
		// Never cached: an STH is the freshness signal a monitor checks, and a
		// stale copy is indistinguishable from the stalled log spec 05 §5.3
		// exists to make visible.
		c.header('cache-control', CACHE_NONE);
		return c.json(head);
	});

	/**
	 * `?hash=&size=` per spec 05 §5.4 and RFC 9162 §4.5, or `?index=&size=` for
	 * a caller that already has the coordinate. Exactly one of the two.
	 */
	app.get('/v1/log/proof/inclusion', async (c) => {
		const hash = optionalHash(c, 'hash');
		if (hash !== undefined && singleQuery(c, 'index') !== undefined) {
			throw badRequest('hash and index must not both be given');
		}
		const size = requireInteger(c, 'size');
		await requireWithinTree(log, 'size', size);
		const index =
			hash === undefined ? requireInteger(c, 'index') : await indexOfLeafHash(deps, hash);
		if (index >= size) throw badRequest('index must be less than size');
		// Permanent: an append-only tree's audit path for a fixed (index, size)
		// pair is a value, not a snapshot.
		c.header('cache-control', CACHE_IMMUTABLE);
		return c.json(await log.inclusionProof(index, size));
	});

	app.get('/v1/log/proof/consistency', async (c) => {
		const from = requireAliasedInteger(c, 'from', 'old');
		const to = requireAliasedInteger(c, 'to', 'new');
		if (from > to) throw badRequest('from must not exceed to');
		await requireWithinTree(log, 'to', to);
		c.header('cache-control', CACHE_IMMUTABLE);
		return c.json(await log.consistencyProof(from, to));
	});

	/**
	 * `start`/`end` are inclusive, as in RFC 9162 §4.6, and the served range is
	 * truncated to one page: a monitor tails the log in pages, and an operator
	 * should not be able to be asked for the whole tree in one request.
	 *
	 * `start === size` answers an empty page — that is what a monitor tailing
	 * the head asks for — while a start beyond the tree is a 400.
	 */
	app.get('/v1/log/entries', async (c) => {
		const start = requireInteger(c, 'start');
		const end = optionalInteger(c, 'end', start + MAX_PAGE_LIMIT - 1);
		if (end < start) throw badRequest('end must not be less than start');
		await requireWithinTree(log, 'start', start);
		const count = Math.min(end - start + 1, MAX_PAGE_LIMIT);
		// Short, not permanent: a range whose end runs past the tail is
		// truncated to what exists now, and that grows.
		c.header('cache-control', CACHE_ANSWER);
		return c.json(await log.entries(start, count));
	});
}
