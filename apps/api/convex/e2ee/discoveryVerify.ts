'use node';

/**
 * The verification half of recipient-key discovery (`e2ee/discovery.ts`) —
 * everything that decides whether fetched bytes may be TRUSTED, before the pin
 * state machine (`e2ee/pinning.ts`) and persistence ever see them:
 *
 *   - {@link keyCertifiesAddress} — the key<->address binding, so a WKD host
 *     cannot serve someone else's key for an address it hosts;
 *   - {@link verifyRotationStatement} / {@link anyRotationValid} — the ONLY
 *     thing that authorizes a silent re-pin across a key change;
 *   - {@link verifyFetchedManifest} — the detached signature over
 *     `/.well-known/owlat.json`.
 *
 * All three are pure of the DB and of the network; none of them throws.
 */

import * as openpgp from 'openpgp';
import { v } from 'convex/values';
import { normalizeEmail } from '@owlat/shared';
import { isRecord } from '@owlat/shared/utils/guards';
import { validatorDecoder } from '@owlat/worker-protocol/decodeJson';
import {
	manifestPayloadFields,
	rotationStatementValidator,
	verifyManifest,
	type ManifestPayload,
} from './manifest';
import { fingerprintsEqual, rotationStatementText, type RotationStatement } from './pinning';

/** The parsed `/.well-known/owlat.json` body — the signed payload plus extras. */
interface FetchedManifest extends ManifestPayload {
	signature: string;
	/** Optional rotation feed (outside the signed payload; verified per-entry). */
	keyRotations?: RotationStatement[];
}

/** The signed payload and its signature: what has to hold before the signature is checked. */
const decodeSignedPayload = validatorDecoder(
	v.object({ ...manifestPayloadFields, signature: v.string() })
);
const decodeRotationStatement = validatorDecoder(rotationStatementValidator);

/**
 * The well-formed entries of a fetched rotation feed. The feed is unsigned and
 * each entry is verified on its own, so an entry that is not a statement is
 * dropped (it could never verify) without discarding the manifest.
 */
function rotationStatementsOf(feed: unknown): RotationStatement[] | undefined {
	if (!Array.isArray(feed)) return undefined;
	return feed.flatMap((entry) => {
		const decoded = decodeRotationStatement(entry);
		return decoded.ok ? [decoded.value] : [];
	});
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
export async function fingerprintOf(armoredKey: string): Promise<string> {
	return (await openpgp.readKey({ armoredKey })).getFingerprint().toUpperCase();
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
		if (!fingerprintsEqual(statement.oldFingerprint, pinnedFingerprint)) return false;
		if (!fingerprintsEqual(statement.newFingerprint, observedFingerprint)) return false;
		// The statement no longer carries its address (L7 — it would enumerate
		// mailboxes on the anonymous manifest). Reconstruct the canonical signed
		// text from the address WE are discovering, so the signature binds the
		// statement to this address: a statement signed for a different address
		// produces different text and fails to verify here.
		const result = await openpgp.verify({
			message: await openpgp.createMessage({
				text: rotationStatementText({
					address,
					oldFingerprint: statement.oldFingerprint,
					newFingerprint: statement.newFingerprint,
				}),
			}),
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

/** True if ANY of the statements is a valid signed rotation to the observed key. */
export async function anyRotationValid(
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
 * Parse, check and signature-verify a fetched manifest. Returns null when
 * absent/invalid: not JSON, a payload field of the wrong type, or a signature
 * that does not verify.
 */
export async function verifyFetchedManifest(bytes: Uint8Array): Promise<FetchedManifest | null> {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
	const checked = decodeSignedPayload(raw);
	if (!checked.ok || !checked.value.instance.publicKeyArmored) return null;
	const parsed = checked.value;
	// Reconstruct EXACTLY the signed payload — everything except the detached
	// `signature` and the unsigned `keyRotations` feed — so canonicalization
	// matches the signer (any extra top-level field would safely fail verify).
	// The values are the fetched ones, unchanged: the check above only reads them.
	const payload: ManifestPayload = {
		version: parsed.version,
		instance: parsed.instance,
		features: parsed.features,
		keyDirectoryDigest: parsed.keyDirectoryDigest,
		rotationFeedUrl: parsed.rotationFeedUrl,
		generatedAt: parsed.generatedAt,
	};
	const ok = await verifyManifest(payload, parsed.signature, parsed.instance.publicKeyArmored);
	if (!ok) return null;
	const keyRotations = rotationStatementsOf(isRecord(raw) ? raw['keyRotations'] : undefined);
	return { ...payload, signature: parsed.signature, ...(keyRotations ? { keyRotations } : {}) };
}
