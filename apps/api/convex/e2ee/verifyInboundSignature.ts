'use node';

/**
 * Inbound PGP signature verification — the `'use node'` plane of the F1
 * verification pipeline (adoption-gaps plan 2026-08-16, decision D9).
 *
 * A message that arrived SIGNED but not encrypted (RFC 3156 `multipart/signed`
 * or an inline clearsigned body) gets its signature verified at ingest:
 *
 *   extraction (`@owlat/mail-canon` byte-exact RFC 3156 first part, or the
 *   clearsigned armor straight from the body)
 *     → sender-key resolution (the SAME TOFU ladder sealed mail uses, but
 *       WKD-first: the instance-manifest fetch is skipped per D9)
 *     → the detached-verify primitive (`manifest.ts:verifyManifest`'s shape)
 *     → an honest {@link InboundSignatureInfo} verdict.
 *
 * FAILURE HONESTY (asserted in tests): every failure path — no key found, a
 * refused key change, a tampered body, a malformed signature part, even an
 * internal verifier error — yields a persisted verdict with
 * `isSignatureValid: false`; NOTHING here ever throws into the ingest path, so
 * delivery is never blocked (D10: verification adds data, never routing).
 *
 * The pure record vocabulary lives in the sibling `e2ee/inboundSignature.ts`;
 * the structural gates live in `@owlat/shared/secureMessage` (shared with the
 * reader's classifier so client and server cannot drift).
 */

import { v, type Infer } from 'convex/values';
import * as openpgp from 'openpgp';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { extractRfc3156SignedPart } from '@owlat/mail-canon';
import {
	extractClearsignedBlock,
	isClearsigned,
	isSignedPgpMime,
} from '@owlat/shared/secureMessage';
import { shouldRefetch } from './discovery';
import { inboundSignatureInfoValidator, type InboundSignatureInfo } from './inboundSignature';

/** The outcome of one low-level verify attempt. Bytes + a key in, structured out. */
export interface VerifyAttempt {
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
 * Verify an inline CLEARSIGNED body (RFC 4880 §7) against a public key. The
 * armor block is pulled straight out of the raw text — clearsigned mail
 * carries its signature inline, so there is no MIME part to extract. Never
 * throws.
 */
export async function verifyClearsignedBody(
	raw: string,
	publicKeyArmored: string
): Promise<VerifyAttempt> {
	const block = extractClearsignedBlock(raw);
	if (!block) return { verified: false, malformed: true };
	let cleartext: Awaited<ReturnType<typeof openpgp.readCleartextMessage>>;
	try {
		cleartext = await openpgp.readCleartextMessage({ cleartextMessage: block });
	} catch {
		return { verified: false, malformed: true };
	}
	try {
		const verificationKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
		const verification = await openpgp.verify({
			message: cleartext,
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

/** How the sender's verification key resolved through the TOFU ladder. */
type ResolvedSenderKey =
	| { status: 'found'; publicKeyArmored: string; keySource: 'pinned' | 'wkd' | 'manifest' }
	| { status: 'keyChanged' }
	| { status: 'notFound' };

/**
 * Resolve the sender's verification key through the SAME TOFU ladder sealed
 * mail uses (`e2ee/open.ts:resolvePinnedSenderKey`), extended with the key's
 * SOURCE for the persisted verdict and running discovery WKD-first
 * (`skipManifest`, D9). Fail-CLOSED throughout: a `keyChanged` conflict is
 * NEVER silently re-pinned, and any discovery error resolves to `notFound`
 * rather than a false claim.
 */
async function resolveSenderKeyWithSource(
	ctx: ActionCtx,
	from: string
): Promise<ResolvedSenderKey> {
	const cached = await ctx.runQuery(internal.e2ee.recipientKeys.getCached, { address: from });
	if (cached && cached.outcome === 'trusted' && cached.pinnedPublicKeyArmored) {
		return {
			status: 'found',
			publicKeyArmored: cached.pinnedPublicKeyArmored,
			keySource: 'pinned',
		};
	}
	// A conflicting pin must stay UNVERIFIED until an admin resolves it.
	if (cached && cached.outcome === 'keyChanged') return { status: 'keyChanged' };
	// A fresh negative (notFound within TTL) would only be answered from cache.
	if (cached && !shouldRefetch(cached, Date.now())) return { status: 'notFound' };

	// First contact (or an expired negative cache): discover once, then re-read.
	// Discovery persists the TOFU pin exactly as sealed mail does (and is the
	// same flag-gated no-op when Sealed Mail is off).
	try {
		await ctx.runAction(internal.e2ee.discovery.discoverRecipientKey, {
			address: from,
			skipManifest: true,
		});
	} catch {
		return { status: 'notFound' };
	}
	const rediscovered = await ctx.runQuery(internal.e2ee.recipientKeys.getCached, { address: from });
	if (rediscovered && rediscovered.outcome === 'trusted' && rediscovered.pinnedPublicKeyArmored) {
		return {
			status: 'found',
			publicKeyArmored: rediscovered.pinnedPublicKeyArmored,
			keySource: rediscovered.source ?? 'wkd',
		};
	}
	if (rediscovered && rediscovered.outcome === 'keyChanged') return { status: 'keyChanged' };
	return { status: 'notFound' };
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
	},
	returns: verifyResultValidator,
	handler: async (ctx, args): Promise<Infer<typeof verifyResultValidator>> => {
		const rawBytes = Buffer.from(args.rawBytesBase64, 'base64');
		const raw = rawBytes.toString('utf8');
		const detached = isSignedPgpMime(raw);
		const clearsigned = !detached && isClearsigned(raw);
		if (!detached && !clearsigned) return { isSigned: false as const };

		try {
			return {
				isSigned: true as const,
				info: await verify(ctx, rawBytes, raw, detached, args.from),
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

/** The verification core: resolve the key, verify, build the honest record. */
async function verify(
	ctx: ActionCtx,
	rawBytes: Buffer,
	raw: string,
	detached: boolean,
	from: string
): Promise<InboundSignatureInfo> {
	const resolved = await resolveSenderKeyWithSource(ctx, from);
	if (resolved.status === 'keyChanged') {
		// Pin refusal (fail-closed, identical to sealed mail): the observed sender
		// key conflicts with the TOFU pin, so no verification claim is possible.
		return { isSigned: true, isSignatureValid: false, keySource: 'pinned', failure: 'key_changed' };
	}
	if (resolved.status === 'notFound') {
		return { isSigned: true, isSignatureValid: false, keySource: 'not_found' };
	}

	let attempt: VerifyAttempt;
	if (detached) {
		const parts = extractRfc3156SignedPart(rawBytes);
		attempt = parts
			? await verifyDetachedSignature(
					parts.signedPart,
					parts.signatureArmored,
					resolved.publicKeyArmored
				)
			: { verified: false, malformed: true };
	} else {
		attempt = await verifyClearsignedBody(raw, resolved.publicKeyArmored);
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
