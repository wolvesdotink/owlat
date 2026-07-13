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
import { createSecretBox } from '../lib/credentialCrypto';
import { getRequired, getOptional } from '../lib/env';

/** Manifest schema version — bump when the signed-payload shape changes. */
export const MANIFEST_VERSION = 1;

/** One published address key, as summarised in the directory digest. */
export interface KeyDirectoryEntry {
	address: string;
	fingerprint: string;
}

/** The SIGNED payload (everything except the detached signature). */
export interface ManifestPayload {
	version: number;
	instance: { fingerprint: string; publicKeyArmored: string };
	features: { e2ee: number };
	keyDirectoryDigest: string;
	rotationFeedUrl: string;
	generatedAt: number;
}

/** The served manifest: the payload plus its armored detached signature. */
export interface SignedManifest extends ManifestPayload {
	signature: string;
}

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
	return stableStringify(payload as unknown as JsonValue);
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
 * null (route 404s) when the instance identity has not been minted yet. Opens
 * the sealed instance private key to sign; never returns it.
 */
export const getSignedManifest = publicAction({
	// public: the instance manifest is a world-readable, signed descriptor (TOFU discovery).
	args: {},
	handler: async (ctx): Promise<SignedManifest | null> => {
		const identity = await ctx.runQuery(internal.e2ee.keys.getInstanceIdentityInternal, {});
		if (!identity) return null;

		const box = createSecretBox(getRequired('INSTANCE_SECRET'), {
			salt: 'owlat:e2ee:keys:salt:v1',
			info: 'owlat:e2ee:keys:v1',
		});
		const privateKeyArmored = box.open(identity.sealedPrivateKey);

		const directory = await ctx.runQuery(internal.e2ee.keys.getKeyDirectory, {});
		const payload = buildManifestPayload({
			instanceFingerprint: identity.fingerprint,
			instancePublicKeyArmored: identity.publicKeyArmored,
			directory,
			rotationFeedUrl: rotationFeedUrl(),
			generatedAt: Date.now(),
		});
		const signature = await signManifest(payload, privateKeyArmored);
		return { ...payload, signature };
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
