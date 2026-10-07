'use node';

/**
 * Inbound PGP signature verification — the `'use node'` plane of the
 * verification pipeline.
 *
 * A message that arrived SIGNED but not encrypted (RFC 3156 `multipart/signed`
 * or an inline clearsigned body) gets its signature verified at ingest:
 *
 *   extraction (`@owlat/mail-canon` byte-exact RFC 3156 first part, or the
 *   clearsigned armor from the transfer-decoded body octets)
 *     → sender-key resolution (`e2ee/senderKey.ts`, the TOFU ladder sealed
 *       mail also uses, run WKD-first: the instance-manifest fetch is skipped)
 *     → the detached-verify primitive (`manifest.ts:verifyManifest`'s shape)
 *     → an honest {@link InboundSignatureInfo} verdict.
 *
 * FAILURE HONESTY (asserted in tests): every failure path — no key found, a
 * refused key change, a tampered body, a malformed signature part, even an
 * internal verifier error — yields a persisted verdict with
 * `isSignatureValid: false`; NOTHING here ever throws into the ingest path, so
 * delivery is never blocked (verification adds data, never routing).
 *
 * The pure record vocabulary lives in the sibling `e2ee/inboundSignature.ts`;
 * the structural gates live in `@owlat/shared/secureMessage` and
 * `@owlat/shared/clearsignedBody` (shared with the reader's classifier so
 * client and server cannot drift).
 */

import { v, type Infer } from 'convex/values';
import * as openpgp from 'openpgp';
import { internalAction, type ActionCtx } from '../_generated/server';
import { extractRfc3156SignedPart } from '@owlat/mail-canon';
import { extractClearsignedBlock, isSignedPgpMime } from '@owlat/shared/secureMessage';
import {
	clearsignedBareBody,
	clearsignedBody,
	type ClearsignedBody,
} from '@owlat/shared/clearsignedBody';
import { binaryStringToBytes, bytesToBinaryString } from '@owlat/shared/mailMime';
import { resolveSenderVerificationKey } from './senderKey';
import { inboundSignatureInfoValidator, type InboundSignatureInfo } from './inboundSignature';

/** The outcome of one low-level verify attempt. Bytes + a key in, structured out. */
interface VerifyAttempt {
	verified: boolean;
	/** Uppercase-hex fingerprint of the verification key — present only when verified. */
	signerFingerprint?: string;
	/** True when the signature/armor itself could not be parsed (vs. merely not verifying). */
	malformed?: boolean;
}

/**
 * Verify a DETACHED armored signature over exact bytes against a public key —
 * the same `openpgp.verify` shape `manifest.ts:verifyManifest` uses, but over
 * a binary message so the RFC 3156 first-part bytes are hashed exactly as
 * transmitted (a text-mode signature canonicalizes to CRLF, which the wire
 * bytes already are). Never throws. A message may carry multiple signature
 * packets and the key's need not be first — accept when ANY verifies.
 */
export async function verifyDetachedSignature(
	signedBytes: Uint8Array,
	armoredSignature: string,
	publicKeyArmored: string
): Promise<VerifyAttempt> {
	let signature: Awaited<ReturnType<typeof openpgp.readSignature>>;
	try {
		signature = await openpgp.readSignature({
			armoredSignature: armoredSignature.replace(/\r\n/g, '\n'),
		});
	} catch {
		return { verified: false, malformed: true };
	}
	try {
		const verificationKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
		const verification = await openpgp.verify({
			message: await openpgp.createMessage({ binary: signedBytes }),
			signature,
			verificationKeys: verificationKey,
		});
		for (const sig of verification.signatures) {
			try {
				await sig.verified;
				return {
					verified: true,
					signerFingerprint: verificationKey.getFingerprint().toUpperCase(),
				};
			} catch {
				// This packet did not verify — a later one still might (stay fail-closed).
			}
		}
		return { verified: false };
	} catch {
		return { verified: false };
	}
}

/**
 * Verify an inline CLEARSIGNED body (RFC 4880 §7) against a public key. `body`
 * is the transmitted octets of the armor block as a BINARY string, one char
 * per byte (`ClearsignedBody.octets`), so the signed octets are hashed as sent
 * whatever their charset. Never throws.
 *
 * openpgp.js reads the armor (dash-unescaping, the `Hash:` header check) but
 * hashes a cleartext message's text as UTF-8, which only matches a UTF-8 body.
 * So the signature is checked as a detached one over the signed text's own
 * bytes instead: openpgp.js's canonical form of it (trailing blanks stripped,
 * CRLF line ends, RFC 4880 §7.1) taken back to octets. A text-mode signature
 * over a binary message hashes exactly those octets.
 *
 * A carriage return that does not end a line fails closed. openpgp.js drops
 * every CR while it reads the armor, so the text it hands back would no longer
 * hold that octet, and a signature could verify over text that differs from the
 * body by it (GnuPG reports such a body as a bad signature).
 */
export async function verifyClearsignedBody(
	body: string,
	publicKeyArmored: string
): Promise<VerifyAttempt> {
	const block = extractClearsignedBlock(body);
	if (!block) return { verified: false, malformed: true };
	// The block's CRLFs are already LF, so any CR left is one that ends no line.
	if (block.includes('\r')) return { verified: false };
	let cleartext: Awaited<ReturnType<typeof openpgp.readCleartextMessage>>;
	try {
		cleartext = await openpgp.readCleartextMessage({ cleartextMessage: block });
	} catch {
		return { verified: false, malformed: true };
	}
	try {
		const signedBytes = binaryStringToBytes(cleartext.getText().replace(/\n/g, '\r\n'));
		// Public on openpgp.js's CleartextMessage, missing from its typings.
		const { signature } = cleartext as unknown as { signature: openpgp.Signature };
		const verificationKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
		const verification = await openpgp.verify({
			message: await openpgp.createMessage({ binary: signedBytes }),
			signature,
			verificationKeys: verificationKey,
		});
		for (const sig of verification.signatures) {
			try {
				await sig.verified;
				return {
					verified: true,
					signerFingerprint: verificationKey.getFingerprint().toUpperCase(),
				};
			} catch {
				// Keep looking — fail-closed when none verify.
			}
		}
		return { verified: false };
	} catch {
		return { verified: false };
	}
}

/** Result of the verification attempt, consumed by `mail/delivery.ts`. */
const verifyResultValidator = v.union(
	// Not structurally signed — the plaintext path is unchanged (no record written).
	v.object({ isSigned: v.literal(false) }),
	// Structurally signed — the honest verdict, whatever the outcome was.
	v.object({ isSigned: v.literal(true), info: inboundSignatureInfoValidator })
);

/**
 * INTERNAL: verify the signature of a structurally SIGNED (unencrypted)
 * inbound message and return the honest verdict for persistence. Called by
 * `mail/delivery.ts:ingestFromWebhook` beside the sealed gate, and by the
 * AI-inbox dispatcher for clearsigned bodies. Never throws past the boundary:
 * an internal failure resolves to a `verification_error` verdict.
 */
export const forInbound = internalAction({
	args: {
		rawBytesBase64: v.string(),
		from: v.string(),
		/**
		 * The bytes are a bare body with no MIME headers (the AI-inbox mirror's
		 * parsed text), so the whole text is the displayed body. Otherwise they
		 * are a raw RFC 5322 message.
		 */
		bareBody: v.optional(v.boolean()),
	},
	returns: verifyResultValidator,
	handler: async (ctx, args): Promise<Infer<typeof verifyResultValidator>> => {
		const rawBytes = Buffer.from(args.rawBytesBase64, 'base64');
		// One char per byte: the structural gates only read ASCII, and the
		// clearsigned text must reach the verifier as the octets that were signed.
		const raw = bytesToBinaryString(rawBytes);
		const detached = isSignedPgpMime(raw);
		const clearsigned = detached ? null : clearsignedRegion(raw, args.bareBody === true);
		if (!detached && clearsigned === null) return { isSigned: false as const };

		try {
			return {
				isSigned: true as const,
				info: await verify(ctx, rawBytes, clearsigned, args.from),
			};
		} catch {
			// The verifier itself failed — record honestly, never block delivery.
			return {
				isSigned: true as const,
				info: {
					isSigned: true,
					isSignatureValid: false,
					keySource: 'not_found',
					failure: 'verification_error',
				},
			};
		}
	},
});

/**
 * The clearsigned block the reader shows, bound to its octets: from the
 * displayed body of a raw message ({@link clearsignedBody}), or from a bare
 * body, whose bytes are its UTF-8 text.
 */
function clearsignedRegion(raw: string, bareBody: boolean): ClearsignedBody | null {
	if (!bareBody) return clearsignedBody(raw);
	return clearsignedBareBody(new TextDecoder().decode(binaryStringToBytes(raw)));
}

/**
 * The verification core: resolve the key, verify, build the honest record.
 * `clearsigned` is the displayed clearsigned block ({@link clearsignedRegion}),
 * or null for RFC 3156 `multipart/signed`. A block no octets can be tied to is
 * recorded as a malformed signature: shown as signed, never as verified.
 */
async function verify(
	ctx: ActionCtx,
	rawBytes: Buffer,
	clearsigned: ClearsignedBody | null,
	from: string
): Promise<InboundSignatureInfo> {
	// WKD-first: an arbitrary PGP sender is rarely an Owlat instance, so the
	// manifest fetch buys nothing (rationale at `discoverKeyForAddress`).
	const resolved = await resolveSenderVerificationKey(ctx, from, { skipManifest: true });
	if (resolved.status === 'keyChanged') {
		// Pin refusal (fail-closed, identical to sealed mail): the observed sender
		// key conflicts with the TOFU pin, so no verification claim is possible.
		return { isSigned: true, isSignatureValid: false, keySource: 'pinned', failure: 'key_changed' };
	}
	if (resolved.status === 'notFound') {
		return { isSigned: true, isSignatureValid: false, keySource: 'not_found' };
	}

	let attempt: VerifyAttempt;
	if (clearsigned === null) {
		const parts = extractRfc3156SignedPart(rawBytes);
		attempt = parts
			? await verifyDetachedSignature(
					parts.signedPart,
					parts.signatureArmored,
					resolved.publicKeyArmored
				)
			: { verified: false, malformed: true };
	} else if (clearsigned.verifiable) {
		attempt = await verifyClearsignedBody(clearsigned.octets, resolved.publicKeyArmored);
	} else {
		attempt = { verified: false, malformed: true };
	}

	if (attempt.verified) {
		return {
			isSigned: true,
			isSignatureValid: true,
			...(attempt.signerFingerprint ? { signerFingerprint: attempt.signerFingerprint } : {}),
			keySource: resolved.keySource,
		};
	}
	return {
		isSigned: true,
		isSignatureValid: false,
		keySource: resolved.keySource,
		...(attempt.malformed ? { failure: 'malformed_signature' } : {}),
	};
}
