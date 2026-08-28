'use node';

/**
 * Recipient-key discovery — the `'use node'` plane of Sealed Mail key discovery
 * (plan 2026-07-11, locked decision D1 PGP/MIME).
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
 * address (`keyCertifiesAddress`) before it is trusted, and the fingerprint runs
 * through the pure TOFU state machine (`e2ee/pinning.ts`). Results (24h positive
 * / 1h negative TTL) land in `recipientKeys` via `e2ee/recipientKeys.ts`; a cron
 * refreshes expiring rows.
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
import {
	evaluatePin,
	fingerprintsEqual,
	type PinDecision,
	type RotationStatement,
} from './pinning';

// Re-export so the module's public surface stays stable after RotationStatement
// (+ rotationStatementText) moved into pinning.ts — consumers still import it here.
export type { RotationStatement } from './pinning';

/** Positive discovery hit is refreshed after 24h. */
export const TTL_FOUND_MS = 24 * 60 * 60 * 1000;
/** A negative result (no usable key) is re-checked after 1h. */
export const TTL_NEGATIVE_MS = 60 * 60 * 1000;

/** The outcome of a discovery fetch, BEFORE pin evaluation / persistence. */
export type DiscoveryFetch =
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
 * `skipManifest` (F1, D9) goes WKD-FIRST for a sender we have no reason to
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
 * Discover (or refresh) the key for one address and persist the discovery +
 * TOFU pin decision. Cache-aware (skips a fresh row unless `force`) and
 * flag-gated (a no-op when Sealed Mail is off). Hoisted out of the action
 * handler so the cron can call it directly — that removes the action→action
 * hop (a Convex antipattern within one runtime) and the same-module `internal`
 * self-reference that would otherwise collapse this module's wired-api types.
 */
async function runRecipientKeyDiscovery(
	ctx: ActionCtx,
	args: { address: string; force?: boolean; skipManifest?: boolean }
): Promise<DiscoveryOutcome> {
	if (!(await ctx.runQuery(internal.e2ee.keys.isSealedMailEnabled, {}))) {
		return { outcome: 'disabled' };
	}
	const address = normalizeEmail(args.address);
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

	// A discovery MISS never drops an existing pin — preserve prior trust, re-check sooner.
	if (fetched.outcome === 'notFound') {
		await ctx.runMutation(internal.e2ee.recipientKeys.upsertDiscovery, {
			address,
			domain,
			outcome: cached?.pinnedFingerprint ? cached.outcome : 'notFound',
			pinnedFingerprint: cached?.pinnedFingerprint,
			pinnedPublicKeyArmored: cached?.pinnedPublicKeyArmored,
			observedFingerprint: cached?.observedFingerprint,
			observedPublicKeyArmored: cached?.observedPublicKeyArmored,
			source: cached?.source,
			instanceFingerprint: fetched.instanceFingerprint ?? cached?.instanceFingerprint,
			expiresAt: now + TTL_NEGATIVE_MS,
		});
		return { outcome: 'notFound' as const };
	}

	const observedFingerprint = fetched.fingerprint;
	const observedArmored = fetched.publicKeyArmored;
	const pinnedFingerprint = cached?.pinnedFingerprint ?? null;

	// Did the remote publish a valid signed rotation from our pin to this key?
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

	const decision: PinDecision = evaluatePin({
		pinnedFingerprint,
		observedFingerprint,
		rotationSignatureValid,
	});

	// On `keyChanged` the pin stays the OLD key; otherwise the observed key
	// becomes the trusted pin.
	const trustedIsObserved = decision.state === 'pinned';
	await ctx.runMutation(internal.e2ee.recipientKeys.upsertDiscovery, {
		address,
		domain,
		outcome: decision.state === 'pinned' ? 'trusted' : 'keyChanged',
		pinnedFingerprint: decision.pinnedFingerprint,
		pinnedPublicKeyArmored: trustedIsObserved ? observedArmored : cached?.pinnedPublicKeyArmored,
		observedFingerprint,
		observedPublicKeyArmored: observedArmored,
		source: 'wkd',
		instanceFingerprint: fetched.instanceFingerprint ?? cached?.instanceFingerprint,
		expiresAt: now + TTL_FOUND_MS,
	});
	return {
		outcome: decision.state === 'pinned' ? 'trusted' : 'keyChanged',
		action: decision.action,
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
		// F1 (D9): WKD-first for arbitrary inbound senders — see discoverKeyForAddress.
		skipManifest: v.optional(v.boolean()),
	},
	handler: (ctx, args) => runRecipientKeyDiscovery(ctx, args),
});

/**
 * INTERNAL (cron): refresh recipient-key rows whose cache has expired. Bounded
 * fan-out per tick; each address re-discovers idempotently. A no-op when Sealed
 * Mail is off.
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
			await runRecipientKeyDiscovery(ctx, { address, force: true });
		}
		return { refreshed: addresses.length };
	},
});
