'use node';

/**
 * Recipient-key discovery — the `'use node'` plane of Sealed Mail key discovery
 * (PGP/MIME).
 *
 * To seal to a remote address we learn its OpenPGP key in two SSRF-disciplined
 * HTTPS fetches against the address's OWN domain: (1) `/.well-known/owlat.json`,
 * the signed instance manifest (TOFU on the instance identity + rotation feed;
 * best-effort — a missing/unverified manifest degrades to WKD-only), then (2)
 * WKD direct method `/.well-known/openpgpkey/hu/<hash>?l=<localpart>`, the
 * authoritative source for the ADDRESS key.
 *
 * This file owns the ORCHESTRATION: which URL is fetched in which order, and
 * the DB-facing discovery/refresh flow. Its two halves live in siblings —
 * `e2ee/discoveryFetch.ts` (SSRF-guarded transport: HTTPS only, public-unicast
 * hosts only, no cross-host redirects, bounded timeout + size cap, injected
 * fetch/DNS) and `e2ee/discoveryVerify.ts` (key<->address binding, signed
 * rotation statements, manifest signature). The fetched key is bound to the
 * address (`keyCertifiesAddress`) before it is trusted. Results (24h positive /
 * 1h negative TTL) land in `recipientKeys` via `e2ee/recipientKeys.ts`, whose
 * commit runs the fingerprint through the pure TOFU state machine
 * (`e2ee/pinning.ts`) against the row at commit time; a cron schedules a
 * refresh of each expiring row.
 */

import { v } from 'convex/values';
import * as openpgp from 'openpgp';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { normalizeEmail } from '@owlat/shared';
import { splitAddress, wkdHashForAddress } from './wkd';
import {
	buildManifestUrl,
	buildWkdUrl,
	defaultDeps,
	guardedFetchBytes,
	type DiscoveryDeps,
} from './discoveryFetch';
import {
	anyRotationValid,
	fingerprintOf,
	keyCertifiesAddress,
	verifyFetchedManifest,
} from './discoveryVerify';
import { fingerprintsEqual, type PinDecision, type RotationStatement } from './pinning';

// Re-export so the module's public surface stays stable after RotationStatement
// (+ rotationStatementText) moved into pinning.ts — consumers still import it here.
export type { RotationStatement } from './pinning';

/** Positive discovery hit is refreshed after 24h. */
const TTL_FOUND_MS = 24 * 60 * 60 * 1000;
/** A negative result (no usable key) is re-checked after 1h. */
export const TTL_NEGATIVE_MS = 60 * 60 * 1000;

/** The outcome of a discovery fetch, BEFORE pin evaluation / persistence. */
type DiscoveryFetch =
	| {
			outcome: 'found';
			fingerprint: string;
			publicKeyArmored: string;
			source: 'wkd';
			instanceFingerprint?: string;
			rotationStatements?: RotationStatement[];
	  }
	| {
			outcome: 'notFound';
			instanceFingerprint?: string;
	  };

/**
 * Fetch + validate a recipient's key from their domain (manifest then WKD). Pure
 * of the DB; SSRF rejections and network errors fail SOFT to `notFound` so a
 * hostile peer can't wedge a send — the guard is still exercised (and asserted)
 * at `guardedFetchBytes`. Never throws.
 *
 * `skipManifest` goes WKD-FIRST for a sender we have no reason to
 * believe is an Owlat instance: the inbound signature verifier resolves keys
 * for arbitrary PGP senders, where `/.well-known/owlat.json` buys nothing (it
 * only supplies the instance fingerprint + rotation feed) and would cost an
 * extra guarded fetch per first-contact sender. The sealed send path keeps the
 * manifest step unchanged.
 */
export async function discoverKeyForAddress(
	address: string,
	deps: DiscoveryDeps = defaultDeps,
	opts: { skipManifest?: boolean } = {}
): Promise<DiscoveryFetch> {
	let domain: string;
	let localPart: string;
	try {
		({ domain, localPart } = splitAddress(address));
	} catch {
		return { outcome: 'notFound' };
	}

	// 1. Manifest (best-effort): instance identity + rotation feed.
	let instanceFingerprint: string | undefined;
	let rotationStatements: RotationStatement[] | undefined;
	if (!opts.skipManifest) {
		try {
			const manifestBytes = await guardedFetchBytes(buildManifestUrl(domain), deps);
			if (manifestBytes) {
				const manifest = await verifyFetchedManifest(manifestBytes);
				if (manifest) {
					instanceFingerprint = manifest.instance.fingerprint.toUpperCase();
					rotationStatements = manifest.keyRotations;
				}
			}
		} catch {
			// SSRF/network on the manifest — degrade to WKD-only.
		}
	}

	// 2. WKD (authoritative for the address key).
	let keyBytes: Uint8Array | null;
	try {
		keyBytes = await guardedFetchBytes(
			buildWkdUrl(domain, localPart, wkdHashForAddress(address)),
			deps
		);
	} catch {
		return { outcome: 'notFound', instanceFingerprint };
	}
	if (!keyBytes) return { outcome: 'notFound', instanceFingerprint };

	let armored: string;
	try {
		armored = (await openpgp.readKey({ binaryKey: keyBytes })).armor();
	} catch {
		return { outcome: 'notFound', instanceFingerprint };
	}
	if (!(await keyCertifiesAddress(armored, address))) {
		return { outcome: 'notFound', instanceFingerprint };
	}
	return {
		outcome: 'found',
		fingerprint: await fingerprintOf(armored),
		publicKeyArmored: armored,
		source: 'wkd',
		instanceFingerprint,
		rotationStatements,
	};
}

/** Cache freshness: re-fetch when there is no row or it has expired. Pure. */
export function shouldRefetch(cached: { expiresAt: number } | null, now: number): boolean {
	return !cached || cached.expiresAt <= now;
}

/** Outcome of discovering (or refreshing) the key for a single address. */
type DiscoveryOutcome = {
	outcome: 'disabled' | 'trusted' | 'keyChanged' | 'notFound';
	cached?: true;
	action?: PinDecision['action'];
};

/**
 * How many times one discovery starts over after the row changed underneath its
 * fetch. Each retry re-reads the row and fetches again (the cache check is
 * skipped: the row was just written by the competing commit, so it always looks
 * fresh), so the committed observation is always newer than the state it
 * transitions from, and a key that differs from the competing pin is recorded
 * as `keyChanged` rather than dropped.
 */
const MAX_DISCOVERY_ATTEMPTS = 3;

/** The arguments of the one write a discovery pass ends in. */
type DiscoveryCommit =
	| {
			kind: 'miss';
			args: {
				address: string;
				domain: string;
				instanceFingerprint?: string;
				expiresAt: number;
			};
	  }
	| {
			kind: 'found';
			args: {
				address: string;
				domain: string;
				basis: { revision: number; pinnedFingerprint?: string };
				fingerprint: string;
				publicKeyArmored: string;
				source: 'wkd';
				rotation?: { oldFingerprint: string; newFingerprint: string };
				instanceFingerprint?: string;
				expiresAt: number;
			};
	  };

/**
 * Discover (or refresh) the key for one address and persist the discovery +
 * TOFU pin decision. Cache-aware (skips a fresh row unless `force`) and
 * flag-gated (a no-op when Sealed Mail is off).
 *
 * Reads and fetches first, then writes once. A found key is only committed
 * against the row it was read against: when `checkDiscoveryBasis` reports that
 * another writer moved the row during the fetch, this starts over from a fresh
 * read. The pin decision itself is made by `recipientKeys.commitDiscoveredKey`
 * against the row at commit time.
 */
async function runRecipientKeyDiscovery(
	ctx: ActionCtx,
	args: { address: string; force?: boolean; skipManifest?: boolean }
): Promise<DiscoveryOutcome> {
	if (!(await ctx.runQuery(internal.e2ee.keys.isSealedMailEnabled, {}))) {
		return { outcome: 'disabled' };
	}
	const address = normalizeEmail(args.address);
	let latest: DiscoveryOutcome['outcome'] = 'notFound';
	let pending: DiscoveryCommit | undefined;
	for (let attempt = 0; attempt < MAX_DISCOVERY_ATTEMPTS && !pending; attempt++) {
		const pass = await discoverOnce(ctx, address, {
			...args,
			force: args.force || attempt > 0,
		});
		if ('outcome' in pass) return pass;
		if (pass.kind === 'miss') {
			pending = pass;
		} else {
			const basis = await ctx.runQuery(internal.e2ee.recipientKeys.checkDiscoveryBasis, {
				address,
				basis: pass.args.basis,
			});
			if (basis.isCurrent) pending = pass;
			else latest = basis.outcome ?? 'notFound';
		}
	}
	// Other writers kept committing between our read and our fetch's end; each of
	// those is at least as fresh as what we would have written, so report the
	// row they left.
	if (!pending) return { outcome: latest };
	return await commitDiscovery(ctx, pending, args.skipManifest);
}

/**
 * The one write of a discovery. A miss never drops an existing pin: it only
 * refreshes metadata on the row as it is at commit time, and re-checks sooner.
 */
async function commitDiscovery(
	ctx: ActionCtx,
	pending: DiscoveryCommit,
	skipManifest: boolean | undefined
): Promise<DiscoveryOutcome> {
	if (pending.kind === 'miss') {
		await ctx.runMutation(internal.e2ee.recipientKeys.recordDiscoveryMiss, pending.args);
		return { outcome: 'notFound' };
	}
	const committed = await ctx.runMutation(
		internal.e2ee.recipientKeys.commitDiscoveredKey,
		pending.args
	);
	if (committed.status === 'committed') {
		return { outcome: committed.outcome, action: committed.action };
	}
	// Another writer committed between the basis check and the commit above, so
	// nothing was written. A fresh, forced discovery fetches again and commits
	// against the row that writer left, so a key that differs from its pin
	// still surfaces as `keyChanged`.
	await ctx.scheduler.runAfter(0, internal.e2ee.discovery.discoverRecipientKey, {
		address: pending.args.address,
		force: true,
		...(skipManifest ? { skipManifest: true } : {}),
	});
	return { outcome: committed.outcome ?? 'notFound' };
}

/** One read -> fetch pass of {@link runRecipientKeyDiscovery}; writes nothing. */
async function discoverOnce(
	ctx: ActionCtx,
	address: string,
	args: { force?: boolean; skipManifest?: boolean }
): Promise<DiscoveryOutcome | DiscoveryCommit> {
	const now = Date.now();
	const cached = await ctx.runQuery(internal.e2ee.recipientKeys.getCached, {
		address,
	});

	if (!args.force && !shouldRefetch(cached, now)) {
		return { outcome: cached?.outcome ?? 'notFound', cached: true };
	}

	const fetched = await discoverKeyForAddress(address, defaultDeps, {
		skipManifest: args.skipManifest ?? false,
	});
	const domain = address.slice(address.lastIndexOf('@') + 1);

	if (fetched.outcome === 'notFound') {
		return {
			kind: 'miss',
			args: {
				address,
				domain,
				instanceFingerprint: fetched.instanceFingerprint,
				expiresAt: now + TTL_NEGATIVE_MS,
			},
		};
	}

	const observedFingerprint = fetched.fingerprint;
	const pinnedFingerprint = cached?.pinnedFingerprint ?? null;

	// Did the remote publish a valid signed rotation from our pin to this key?
	// The proof is handed to the commit bound to the exact pin it was checked
	// against; the commit ignores it if the pin has moved.
	const rotationSignatureValid =
		pinnedFingerprint !== null &&
		!fingerprintsEqual(pinnedFingerprint, observedFingerprint) &&
		cached?.pinnedPublicKeyArmored !== undefined
			? await anyRotationValid(
					cached.pinnedPublicKeyArmored,
					fetched.rotationStatements ?? [],
					address,
					pinnedFingerprint,
					observedFingerprint
				)
			: false;

	return {
		kind: 'found',
		args: {
			address,
			domain,
			basis: {
				revision: cached?.revision ?? 0,
				pinnedFingerprint: pinnedFingerprint ?? undefined,
			},
			fingerprint: observedFingerprint,
			publicKeyArmored: fetched.publicKeyArmored,
			source: fetched.source,
			rotation:
				rotationSignatureValid && pinnedFingerprint !== null
					? { oldFingerprint: pinnedFingerprint, newFingerprint: observedFingerprint }
					: undefined,
			instanceFingerprint: fetched.instanceFingerprint,
			expiresAt: now + TTL_FOUND_MS,
		},
	};
}

/**
 * INTERNAL: discover (or refresh) the key for one address and persist the
 * discovery + TOFU pin decision. Thin wrapper over {@link runRecipientKeyDiscovery}.
 */
export const discoverRecipientKey = internalAction({
	args: {
		address: v.string(),
		force: v.optional(v.boolean()),
		// WKD-first for arbitrary inbound senders — see discoverKeyForAddress.
		skipManifest: v.optional(v.boolean()),
	},
	handler: (ctx, args) => runRecipientKeyDiscovery(ctx, args),
});

/**
 * INTERNAL (cron): refresh recipient-key rows whose cache has expired. Bounded
 * fan-out per tick: each address re-discovers in a `discoverRecipientKey` run of
 * its own, which commits once, so one address's failure leaves the others' work
 * in place. A no-op when Sealed Mail is off.
 */
export const refreshExpiringRecipientKeys = internalAction({
	args: {},
	handler: async (ctx): Promise<{ refreshed: number }> => {
		if (!(await ctx.runQuery(internal.e2ee.keys.isSealedMailEnabled, {}))) {
			return { refreshed: 0 };
		}
		const addresses = await ctx.runQuery(internal.e2ee.recipientKeys.listExpiring, {
			before: Date.now(),
			limit: 50,
		});
		for (const address of addresses) {
			await ctx.scheduler.runAfter(0, internal.e2ee.discovery.discoverRecipientKey, {
				address,
				force: true,
			});
		}
		return { refreshed: addresses.length };
	},
});
