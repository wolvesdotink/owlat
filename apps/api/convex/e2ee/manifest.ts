'use node';

/**
 * Signed instance manifest — `/.well-known/owlat.json`.
 *
 * A world-readable descriptor another Owlat instance fetches to learn how to
 * reach us securely: our instance signing public key, the features we support
 * (`e2ee: 1`), a digest of our published address-key directory, and a
 * rotation-feed URL to re-poll. The whole payload is SIGNED by the instance
 * identity private key (a detached OpenPGP signature), so a fetcher can pin our
 * key on first contact (TOFU) and detect tampering thereafter.
 *
 * Node plane (`openpgp` + secret box). Pure helpers (`buildManifestPayload`,
 * `keyDirectoryDigest`, `canonicalManifest`, `signManifest`, `verifyManifest`)
 * are unit-tested directly; `getSignedManifest` wires them to the vault.
 */

import { createHash } from 'node:crypto';
import * as openpgp from 'openpgp';
import { publicAction } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { openPrivateKey } from './sealing';
import type { RotationStatement } from './pinning';

/** Manifest schema version — bump when the signed-payload shape changes. */
export const MANIFEST_VERSION = 1;

/** One published address key, as summarised in the directory digest. */
export interface KeyDirectoryEntry {
	address: string;
	fingerprint: string;
}

/**
 * The SIGNED payload (everything except the detached signature). Declared as a
 * `type` alias (not an `interface`) so it is structurally assignable to
 * `JsonValue` — `canonicalManifest` can serialize it without a cast.
 */
export type ManifestPayload = {
	version: number;
	instance: { fingerprint: string; publicKeyArmored: string };
	features: { e2ee: number };
	keyDirectoryDigest: string;
	rotationFeedUrl: string;
	generatedAt: number;
};

/** The served manifest: the payload plus its armored detached signature. */
export type SignedManifest = ManifestPayload & {
	signature: string;
	/**
	 * The key-rotation feed (E6) — signed old->new statements a peer verifies
	 * against a pin it already holds to upgrade silently. OUTSIDE the signed
	 * payload (each entry is self-authenticating via its own detached signature),
	 * so it never affects `keyDirectoryDigest` / signature verification. Absent
	 * when this instance has never rotated a key.
	 */
	keyRotations?: RotationStatement[];
};

/**
 * A digest of the published address-key directory: SHA-256 (hex) over the
 * address->fingerprint pairs, sorted by address, one `address\tfingerprint` line
 * each. Deterministic and order-independent, so a fetcher can tell at a glance
 * whether our directory changed since it last synced.
 */
export function keyDirectoryDigest(entries: KeyDirectoryEntry[]): string {
	const lines = entries
		.map((e) => `${e.address.toLowerCase()}\t${e.fingerprint.toUpperCase()}`)
		.sort();
	return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/** Build the (unsigned) manifest payload from its inputs. */
export function buildManifestPayload(input: {
	instanceFingerprint: string;
	instancePublicKeyArmored: string;
	directory: KeyDirectoryEntry[];
	rotationFeedUrl: string;
	generatedAt: number;
}): ManifestPayload {
	return {
		version: MANIFEST_VERSION,
		instance: {
			fingerprint: input.instanceFingerprint.toUpperCase(),
			publicKeyArmored: input.instancePublicKeyArmored,
		},
		features: { e2ee: 1 },
		keyDirectoryDigest: keyDirectoryDigest(input.directory),
		rotationFeedUrl: input.rotationFeedUrl,
		generatedAt: input.generatedAt,
	};
}

/** Recursively key-sorted JSON — the exact bytes the signature covers. */
export function canonicalManifest(payload: ManifestPayload): string {
	return stableStringify(payload);
}

/** Sign the canonical payload with the instance private key. Returns an armored detached signature. */
export async function signManifest(
	payload: ManifestPayload,
	privateKeyArmored: string
): Promise<string> {
	const privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
	return openpgp.sign({
		message: await openpgp.createMessage({ text: canonicalManifest(payload) }),
		signingKeys: privateKey,
		detached: true,
		format: 'armored',
	});
}

/** Verify a manifest's detached signature against a public key. Never throws. */
export async function verifyManifest(
	payload: ManifestPayload,
	armoredSignature: string,
	publicKeyArmored: string
): Promise<boolean> {
	try {
		const verification = await openpgp.verify({
			message: await openpgp.createMessage({ text: canonicalManifest(payload) }),
			signature: await openpgp.readSignature({ armoredSignature }),
			verificationKeys: await openpgp.readKey({ armoredKey: publicKeyArmored }),
		});
		const first = verification.signatures[0];
		if (!first) return false;
		await first.verified;
		return true;
	} catch {
		return false;
	}
}

/** The rotation-feed URL: re-poll the manifest itself; its digest changes on rotation. */
function rotationFeedUrl(): string {
	const base = (getOptional('SITE_URL') ?? '').replace(/\/+$/, '');
	return `${base}/.well-known/owlat.json`;
}

/**
 * PUBLIC: the signed instance manifest for `/.well-known/owlat.json`. Returns
 * null (route 404s) when Sealed Mail is disabled or the instance identity has
 * not been minted yet.
 *
 * Serves the manifest cached on the instance row when it still matches the
 * current key-directory digest and instance key, re-signing (and re-caching)
 * only when either changes. This keeps the bytes stable for HTTP caching /
 * verifier comparison and avoids doing anonymous per-request OpenPGP signing.
 */
export const getSignedManifest = publicAction({
	// public: the instance manifest is a world-readable, signed descriptor (TOFU discovery).
	args: {},
	handler: async (ctx): Promise<SignedManifest | null> => {
		// Publication follows the flag: once an admin turns Sealed Mail OFF we stop
		// advertising `features.e2ee` even though minted keys remain at rest.
		if (!(await ctx.runQuery(internal.e2ee.keys.isSealedMailEnabled, {}))) return null;

		const identity = await ctx.runQuery(internal.e2ee.keys.getInstanceIdentityInternal, {});
		if (!identity) return null;

		const directory = await ctx.runQuery(internal.e2ee.keys.getKeyDirectory, {});
		const digest = keyDirectoryDigest(directory);
		const feedUrl = rotationFeedUrl();

		const cached = identity.cachedManifest;
		if (
			cached &&
			cached.keyDirectoryDigest === digest &&
			cached.instanceFingerprint === identity.fingerprint &&
			cached.rotationFeedUrl === feedUrl
		) {
			return JSON.parse(cached.signedManifestJson) as SignedManifest;
		}

		const privateKeyArmored = openPrivateKey(identity.sealedPrivateKey);
		const payload = buildManifestPayload({
			instanceFingerprint: identity.fingerprint,
			instancePublicKeyArmored: identity.publicKeyArmored,
			directory,
			rotationFeedUrl: feedUrl,
			generatedAt: Date.now(),
		});
		const signature = await signManifest(payload, privateKeyArmored);
		// The rotation feed rides OUTSIDE the signed payload — each entry carries its
		// own detached signature by the old key, so it needs no manifest-wide sig. A
		// rotation changes an active address fingerprint, which changes the
		// keyDirectoryDigest above, so the cache invalidates and this refreshes.
		const keyRotations = await ctx.runQuery(internal.e2ee.lifecycle.listRotationStatements, {});
		const signed: SignedManifest = {
			...payload,
			signature,
			...(keyRotations.length > 0 ? { keyRotations } : {}),
		};

		await ctx.runMutation(internal.e2ee.keys.cacheInstanceManifest, {
			keyDirectoryDigest: digest,
			instanceFingerprint: identity.fingerprint,
			rotationFeedUrl: feedUrl,
			signedManifestJson: JSON.stringify(signed),
		});
		return signed;
	},
});

// ─── stable JSON ────────────────────────────────────────────────────────────

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function stableStringify(value: JsonValue): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const keys = Object.keys(value).sort();
	const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] as JsonValue)}`);
	return `{${body.join(',')}}`;
}
