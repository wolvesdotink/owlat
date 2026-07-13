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
 * SSRF DISCIPLINE THROUGHOUT (copied from the MTA-STS verifier
 * `domains/mtaStsVerify.ts`): HTTPS only, public-unicast hosts only (every
 * resolved address run through the shared `isDisallowedIpAddress` blocklist), NO
 * cross-host redirects (any 3xx rejected), a bounded timeout, and a streamed
 * size cap. Fetch + DNS are injected via {@link DiscoveryDeps} so the whole path
 * is unit-testable without a network. The fetched key is bound to the address
 * ({@link keyCertifiesAddress}) before it is trusted, and the fingerprint runs
 * through the pure TOFU state machine (`e2ee/pinning.ts`). Results (24h positive
 * / 1h negative TTL) land in `recipientKeys` via `e2ee/recipientKeys.ts`; a cron
 * refreshes expiring rows.
 */

import { v } from 'convex/values';
import * as openpgp from 'openpgp';
import dns from 'node:dns/promises';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { isDisallowedIpAddress } from '../lib/ipBlocklist';
import { readCappedBytes, CappedReadOverflow, guardedDispatcher } from '../lib/ssrfGuard';
import { normalizeEmail } from '@owlat/shared';
import { splitAddress, wkdHashForAddress } from './wkd';
import { verifyManifest, type ManifestPayload } from './manifest';
import { evaluatePin, fingerprintsEqual, type PinDecision } from './pinning';

/** Positive discovery hit is refreshed after 24h. */
export const TTL_FOUND_MS = 24 * 60 * 60 * 1000;
/** A negative result (no usable key) is re-checked after 1h. */
export const TTL_NEGATIVE_MS = 60 * 60 * 1000;
/** Hard ceiling on a discovery fetch (mirrors the MTA-STS verify timeout). */
const FETCH_TIMEOUT_MS = 10_000;
/** A manifest / transferable public key is small; cap the read to bound memory. */
const MAX_BYTES = 256 * 1024;

/** Thrown when a fetch is rejected for an SSRF reason (non-https, redirect, private host, oversize). */
export class SsrfRejection extends Error {}

/** A signed rotation statement, published in the manifest rotation feed. */
export interface RotationStatement {
	address: string;
	oldFingerprint: string;
	newFingerprint: string;
	/** Armored detached signature by the OLD key over the canonical statement. */
	signature: string;
}

/** The parsed `/.well-known/owlat.json` body — the signed payload plus extras. */
interface FetchedManifest extends ManifestPayload {
	signature: string;
	/** Optional rotation feed (outside the signed payload; verified per-entry). */
	keyRotations?: RotationStatement[];
}

/** Injected DNS + HTTPS primitives so discovery is testable without a network. */
export interface DiscoveryDeps {
	/** Resolve every address for a host (per `node:dns` `lookup({ all: true })`). */
	lookup(host: string): Promise<{ address: string }[]>;
	/** Fetch a URL — structural (not `typeof fetch`), matching the MTA-STS deps shape. */
	fetch(input: string, init?: RequestInit): Promise<Response>;
}

const defaultDeps: DiscoveryDeps = {
	lookup: (host) => dns.lookup(host, { all: true }),
	fetch: (input, init) =>
		fetch(input, {
			...init,
			// @ts-expect-error `dispatcher` is an undici-specific fetch option not in
			// the DOM RequestInit lib types, but valid in the Node action runtime. It
			// binds the socket-level DNS lookup to the SSRF blocklist, closing the
			// connect-time DNS-rebinding TOCTOU the up-front resolve can't (recipient
			// domains are attacker-influenceable — anyone you mail).
			dispatcher: guardedDispatcher(),
		}),
};

/** The manifest URL for a domain. */
export function buildManifestUrl(domain: string): string {
	return `https://${domain.toLowerCase()}/.well-known/owlat.json`;
}

/** The WKD direct-method URL for an address (matches how Owlat publishes). */
export function buildWkdUrl(domain: string, localPart: string, wkdHash: string): string {
	return `https://${domain.toLowerCase()}/.well-known/openpgpkey/hu/${wkdHash}?l=${encodeURIComponent(localPart)}`;
}

/**
 * SSRF-guarded HTTPS GET returning the raw body bytes, or `null` when the
 * resource legitimately isn't there (404 / non-2xx / empty resolution).
 * THROWS {@link SsrfRejection} on a security violation (non-https, a redirect,
 * a host that resolves to a private/link-local/loopback address, or an
 * over-cap body) so those are never silently treated as "no key".
 */
export async function guardedFetchBytes(
	urlStr: string,
	deps: DiscoveryDeps = defaultDeps
): Promise<Uint8Array | null> {
	let url: URL;
	try {
		url = new URL(urlStr);
	} catch {
		throw new SsrfRejection(`invalid URL: ${urlStr}`);
	}
	// HTTPS only — a plain-http target (or an http redirect) can't be trusted.
	if (url.protocol !== 'https:') {
		throw new SsrfRejection(`refusing non-https URL: ${urlStr}`);
	}
	// Resolve the host and reject if ANY address is private/link-local/loopback.
	// Best-effort (the socket re-resolves independently), narrowing the common
	// misconfig/abuse case exactly like the MTA-STS verifier.
	let addresses: { address: string }[];
	try {
		addresses = await deps.lookup(url.hostname);
	} catch {
		return null; // unresolvable host — nothing to fetch (negative), not an attack.
	}
	if (addresses.length === 0) return null;
	if (addresses.some((a) => isDisallowedIpAddress(a.address))) {
		throw new SsrfRejection(
			`host ${url.hostname} resolves to a disallowed (private/internal) address`
		);
	}

	const res = await deps.fetch(urlStr, {
		redirect: 'manual',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	// Reject ALL redirects — an attacker-controlled public host could 30x to an
	// internal target, defeating the up-front check.
	if (res.status >= 300 && res.status < 400) {
		throw new SsrfRejection(`refusing to follow redirect from ${urlStr}`);
	}
	if (res.status === 404) return null;
	if (!res.ok) return null;

	// Reject an over-cap Content-Length, then enforce the cap while streaming too.
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > MAX_BYTES) {
		throw new SsrfRejection(`response from ${urlStr} exceeds ${MAX_BYTES} bytes`);
	}
	// An over-cap streamed body is an SSRF-class rejection here (never silently a
	// "no key"): translate the shared reader's overflow into an SsrfRejection.
	try {
		return await readCappedBytes(res.body, MAX_BYTES);
	} catch (err) {
		if (err instanceof CappedReadOverflow) {
			throw new SsrfRejection(`response from ${urlStr} exceeds ${MAX_BYTES} bytes`);
		}
		throw err;
	}
}

/**
 * True iff the armored key carries a User ID for the EXACT address WITH a valid
 * self-certification ON that matching UID — the key<->address binding. Rejects a
 * key for a different address (the spoof case: a WKD host serving someone else's
 * key) AND a hybrid key that merely LISTS the address on an uncertified UID
 * grafted onto a third party's real key (the key's own valid UID would otherwise
 * satisfy a key-wide primary-user check). `getPrimaryUser` filtered by the email
 * selects only users whose UID matches `target` and requires a valid self-cert on
 * one of them, throwing otherwise. Never throws.
 */
export async function keyCertifiesAddress(armoredKey: string, address: string): Promise<boolean> {
	try {
		const key = await openpgp.readKey({ armoredKey });
		const target = normalizeEmail(address);
		await key.getPrimaryUser(undefined, { email: target });
		return true;
	} catch {
		return false;
	}
}

/** The uppercase-hex primary fingerprint of an armored key. */
async function fingerprintOf(armoredKey: string): Promise<string> {
	return (await openpgp.readKey({ armoredKey })).getFingerprint().toUpperCase();
}

/** The canonical bytes a rotation statement's signature covers. */
function rotationStatementText(s: RotationStatement): string {
	return [
		'owlat-key-rotation',
		normalizeEmail(s.address),
		s.oldFingerprint.replace(/\s+/g, '').toUpperCase(),
		s.newFingerprint.replace(/\s+/g, '').toUpperCase(),
	].join('\n');
}

/**
 * True iff `statement` is validly signed by `oldPinnedKeyArmored` AND binds the
 * currently-pinned fingerprint to the observed one for `address`. This is the
 * ONLY thing that authorizes a silent re-pin across a key change. Never throws.
 */
export async function verifyRotationStatement(
	oldPinnedKeyArmored: string,
	statement: RotationStatement,
	address: string,
	pinnedFingerprint: string,
	observedFingerprint: string
): Promise<boolean> {
	try {
		if (normalizeEmail(statement.address) !== normalizeEmail(address)) return false;
		if (!fingerprintsEqual(statement.oldFingerprint, pinnedFingerprint)) return false;
		if (!fingerprintsEqual(statement.newFingerprint, observedFingerprint)) return false;
		const result = await openpgp.verify({
			message: await openpgp.createMessage({ text: rotationStatementText(statement) }),
			signature: await openpgp.readSignature({ armoredSignature: statement.signature }),
			verificationKeys: await openpgp.readKey({ armoredKey: oldPinnedKeyArmored }),
		});
		const first = result.signatures[0];
		if (!first) return false;
		await first.verified;
		return true;
	} catch {
		return false;
	}
}

/** Parse + signature-verify a fetched manifest. Returns null when absent/invalid. */
async function verifyFetchedManifest(bytes: Uint8Array): Promise<FetchedManifest | null> {
	let parsed: FetchedManifest;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes)) as FetchedManifest;
	} catch {
		return null;
	}
	if (!parsed?.instance?.publicKeyArmored || typeof parsed.signature !== 'string') return null;
	// Reconstruct EXACTLY the signed payload — everything except the detached
	// `signature` and the unsigned `keyRotations` feed — so canonicalization
	// matches the signer (any extra top-level field would safely fail verify).
	const payload: ManifestPayload = {
		version: parsed.version,
		instance: parsed.instance,
		features: parsed.features,
		keyDirectoryDigest: parsed.keyDirectoryDigest,
		rotationFeedUrl: parsed.rotationFeedUrl,
		generatedAt: parsed.generatedAt,
	};
	const ok = await verifyManifest(payload, parsed.signature, parsed.instance.publicKeyArmored);
	return ok ? parsed : null;
}

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
 * at {@link guardedFetchBytes}. Never throws.
 */
export async function discoverKeyForAddress(
	address: string,
	deps: DiscoveryDeps = defaultDeps
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
	args: { address: string; force?: boolean }
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

	const fetched = await discoverKeyForAddress(address, defaultDeps);
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
	args: { address: v.string(), force: v.optional(v.boolean()) },
	handler: (ctx, args) => runRecipientKeyDiscovery(ctx, args),
});

/** True if ANY of the statements is a valid signed rotation to the observed key. */
async function anyRotationValid(
	oldPinnedKeyArmored: string,
	statements: RotationStatement[],
	address: string,
	pinnedFingerprint: string,
	observedFingerprint: string
): Promise<boolean> {
	for (const statement of statements) {
		if (
			await verifyRotationStatement(
				oldPinnedKeyArmored,
				statement,
				address,
				pinnedFingerprint,
				observedFingerprint
			)
		) {
			return true;
		}
	}
	return false;
}

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
