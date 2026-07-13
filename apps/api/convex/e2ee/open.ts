'use node';

/**
 * Inbound unsealing — the `'use node'` plane of decrypt-on-ingest (Sealed Mail
 * plan 2026-07-11, locked decision D3).
 *
 * D3: DECRYPT-ON-INGEST. When a sealed PGP/MIME message arrives for an address we
 * hold a vault key for, we decrypt it here and let the PLAINTEXT flow into the
 * normal pipeline (categorize / needs-reply / agent / knowledge / search all keep
 * working); the sealed original is retained as the raw `.eml`. The body is
 * decrypted with the recipient's vault key, the signature is verified against the
 * discovered/pinned SENDER key, and the protected headers (real Subject, D4) are
 * restored from the inner MIME.
 *
 * FAILURE HONESTY (asserted in tests): a message we cannot decrypt (no usable
 * key / bad ciphertext) leaves today's "Encrypted — can't decrypt" path
 * untouched — the sealed original stays downloadable and NO signature claim is
 * made. A message that decrypts but whose signature does NOT verify against the
 * pinned key is stored as `signatureValid: false` (UNVERIFIED) — never
 * "verified".
 *
 * The pure detection + protected-header restoration + the record validator live
 * in the pure sibling `e2ee/inboundSeal.ts`; this file adds only the OpenPGP
 * decrypt/verify (which needs `openpgp`, hence `'use node'`) and the two ingest
 * entry actions.
 */

import { v } from 'convex/values';
import * as openpgp from 'openpgp';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { extractArmoredCiphertext } from '@owlat/shared/secureMessage';
import { normalizeEmail } from '@owlat/shared';
import { openPrivateKey } from './sealing';
import { shouldRefetch } from './discovery';
import {
	decodeUtf8,
	INBOUND_CIPHER_SUITE,
	inboundEncryptionInfoValidator,
	isSealedPgpMime,
	parseInnerMessage,
	type InboundEncryptionInfo,
} from './inboundSeal';

/** The outcome of a low-level open attempt. Bytes + keys in, structured out. */
export type OpenOutcome =
	| { status: 'opened'; innerMime: string; signatureValid: boolean; signerFingerprint?: string }
	| { status: 'cannotDecrypt' };

export interface OpenParams {
	/** The raw sealed message (PGP/MIME) or its inline-armored body. */
	raw: string;
	/** Armored PRIVATE keys of the recipient addresses we hold in the vault. */
	recipientPrivateKeysArmored: string[];
	/** Armored PUBLIC key of the pinned sender, when we have one (else no verify). */
	senderPublicKeyArmored?: string;
}

/**
 * Decrypt + signature-verify a sealed message. PURE of `ctx`/db — bytes and keys
 * in, an outcome out — so it is unit-testable against committed fixtures and the
 * E3 sealer without a network or the vault. Never throws: a decrypt failure
 * (wrong/absent key, corrupt ciphertext) resolves to `cannotDecrypt`, and a
 * signature that does not verify resolves to `signatureValid: false` (never a
 * thrown error that would fail ingest).
 */
export async function openSealed(params: OpenParams): Promise<OpenOutcome> {
	const armored = extractArmoredCiphertext(params.raw);
	if (!armored) return { status: 'cannotDecrypt' };
	if (params.recipientPrivateKeysArmored.length === 0) return { status: 'cannotDecrypt' };

	// Verify against the pinned sender key when we have one; otherwise decrypt
	// without a verification claim (signatureValid stays false — UNVERIFIED). A
	// malformed sender key is treated as "no verification key", never a decrypt
	// failure.
	let verificationKey: Awaited<ReturnType<typeof openpgp.readKey>> | undefined;
	if (params.senderPublicKeyArmored) {
		try {
			verificationKey = await openpgp.readKey({ armoredKey: params.senderPublicKeyArmored });
		} catch {
			verificationKey = undefined;
		}
	}

	let innerMime: string;
	let signatureValid = false;
	let signerFingerprint: string | undefined;
	try {
		const message = await openpgp.readMessage({ armoredMessage: armored });
		const decryptionKeys = await Promise.all(
			params.recipientPrivateKeysArmored.map((armoredKey) => openpgp.readPrivateKey({ armoredKey }))
		);
		const decrypted = await openpgp.decrypt({
			message,
			decryptionKeys,
			...(verificationKey ? { verificationKeys: verificationKey } : {}),
			format: 'binary',
		});
		innerMime = decodeUtf8(decrypted.data as Uint8Array);

		// Signature verification is fail-CLOSED: only a signature that is PRESENT
		// and verifies against the pinned key counts. An absent signature, an
		// unverifiable one, or a decrypt without a pinned key all keep
		// signatureValid: false. A message may carry MULTIPLE signatures and the
		// pinned key's need not be first — accept when ANY verifies against it.
		if (verificationKey) {
			for (const sig of decrypted.signatures) {
				try {
					await sig.verified;
					signatureValid = true;
					signerFingerprint = verificationKey.getFingerprint().toUpperCase();
					break;
				} catch {
					// This signature did not verify against the pinned key — a later
					// entry still might, so keep looking (stay fail-closed if none do).
				}
			}
		}
	} catch {
		// A wrong/absent recipient key or corrupt ciphertext surfaces here — the
		// "Encrypted — can't decrypt" path.
		return { status: 'cannotDecrypt' };
	}

	const outcome: OpenOutcome = { status: 'opened', innerMime, signatureValid };
	if (signerFingerprint) outcome.signerFingerprint = signerFingerprint;
	return outcome;
}

/** The domain (sending instance) of an address, lower-cased; undefined when unparseable. */
function instanceOf(address: string): string | undefined {
	const at = address.lastIndexOf('@');
	return at >= 0 ? address.slice(at + 1).toLowerCase() || undefined : undefined;
}

/** Result of the mailbox-path open attempt, consumed by `mail/delivery.ts`. */
const mailboxOpenResultValidator = v.union(
	// Not a sealed message, OR Sealed Mail is off — the plaintext fast path is
	// unchanged (no bodies touched, no record written).
	v.object({ sealed: v.literal(false) }),
	// Sealed and successfully opened — the restored plaintext + honest record.
	v.object({
		sealed: v.literal(true),
		decrypted: v.literal(true),
		subject: v.optional(v.string()),
		text: v.optional(v.string()),
		html: v.optional(v.string()),
		encryptionInfo: inboundEncryptionInfoValidator,
	}),
	// Sealed but undecryptable — today's "Encrypted — can't decrypt" path.
	v.object({
		sealed: v.literal(true),
		decrypted: v.literal(false),
		encryptionInfo: inboundEncryptionInfoValidator,
	})
);

/**
 * INTERNAL: attempt to open a sealed message on the personal-mailbox ingest path.
 * Called by `mail/delivery.ts:ingestFromWebhook` BEFORE the body split. Returns
 * the restored plaintext + honest `inboundEncryptionInfo` on success, a
 * decrypt-false record when we hold no usable key, or `{ sealed: false }` when
 * the message is not sealed (or the flag is off) so the existing plaintext path
 * is byte-for-byte unchanged.
 */
export const openInboundForMailbox = internalAction({
	args: {
		rawBytesBase64: v.string(),
		recipientAddress: v.string(),
		from: v.string(),
	},
	returns: mailboxOpenResultValidator,
	handler: async (ctx, args) => {
		// Flag OFF ⇒ behave exactly as before: never decrypt, never record. A sealed
		// message just stays ciphertext (the reader's existing "Encrypted" badge).
		if (!(await ctx.runQuery(internal.e2ee.keys.isSealedMailEnabled, {}))) {
			return { sealed: false as const };
		}

		const raw = Buffer.from(args.rawBytesBase64, 'base64').toString('utf8');
		if (!isSealedPgpMime(raw)) return { sealed: false as const };

		const outcome = await openWithVault(ctx, raw, args.recipientAddress, args.from);
		if (outcome.status === 'cannotDecrypt') {
			return {
				sealed: true as const,
				decrypted: false as const,
				encryptionInfo: { sealed: true, decrypted: false },
			};
		}

		const restored = parseInnerMessage(outcome.innerMime);
		const fromAddress = normalizeEmail(args.from);
		const encryptionInfo = buildOpenedInfo(outcome, fromAddress);
		return {
			sealed: true as const,
			decrypted: true as const,
			...(restored.subject !== undefined ? { subject: restored.subject } : {}),
			...(restored.text !== undefined ? { text: restored.text } : {}),
			...(restored.html !== undefined ? { html: restored.html } : {}),
			encryptionInfo,
		};
	},
});

/**
 * INTERNAL: decrypt a sealed inbound message on the AI-inbox path and hand the
 * PLAINTEXT to `inbox.messages.receiveMessage`, so the agent pipeline + the
 * unified-timeline mirror consume decrypted text (D3). Called by
 * `webhooks/dispatcher.ts` when an inbound event carries an armored ciphertext.
 * On a decrypt failure the ORIGINAL (ciphertext) body is passed through with the
 * `sealed` flag but NO signature claim — the reader's existing "Encrypted" path.
 */
export const decryptAndReceive = internalAction({
	args: {
		armoredCiphertext: v.string(),
		recipientAddress: v.string(),
		from: v.string(),
		to: v.string(),
		subject: v.string(),
		textBody: v.optional(v.string()),
		htmlBody: v.optional(v.string()),
		headers: v.optional(v.string()),
		messageId: v.string(),
		inReplyTo: v.optional(v.string()),
		references: v.optional(v.string()),
		attachmentMeta: v.optional(v.string()),
		timestamp: v.number(),
		spfResult: v.optional(v.string()),
		dkimResult: v.optional(v.string()),
		dmarcResult: v.optional(v.string()),
		dmarcPolicy: v.optional(v.string()),
	},
	returns: v.object({
		inboundMessageId: v.id('inboundMessages'),
		threadId: v.id('conversationThreads'),
		contactId: v.id('contacts'),
	}),
	handler: async (ctx, args) => {
		const outcome = await openWithVault(
			ctx,
			args.armoredCiphertext,
			args.recipientAddress,
			args.from
		);

		let subject = args.subject;
		let textBody = args.textBody;
		let htmlBody = args.htmlBody;
		let sealedFlags: {
			isSealed: true;
			isSignatureValid?: boolean;
			signerFingerprint?: string;
			signerInstance?: string;
		} = { isSealed: true };

		if (outcome.status === 'opened') {
			const restored = parseInnerMessage(outcome.innerMime);
			if (restored.subject !== undefined) subject = restored.subject;
			// The decrypted plaintext REPLACES the ciphertext body so the agent
			// pipeline + the unified mirror consume real text (D3).
			textBody = restored.text;
			htmlBody = restored.html;
			const info = buildOpenedInfo(outcome, normalizeEmail(args.from));
			sealedFlags = {
				isSealed: true,
				isSignatureValid: info.signatureValid,
				...(info.signerFingerprint ? { signerFingerprint: info.signerFingerprint } : {}),
				...(info.signerInstance ? { signerInstance: info.signerInstance } : {}),
			};
		}

		return await ctx.runMutation(internal.inbox.messages.receiveMessage, {
			from: args.from,
			to: args.to,
			subject,
			textBody,
			htmlBody,
			headers: args.headers,
			messageId: args.messageId,
			inReplyTo: args.inReplyTo,
			references: args.references,
			attachmentMeta: args.attachmentMeta,
			timestamp: args.timestamp,
			spfResult: args.spfResult,
			dkimResult: args.dkimResult,
			dmarcResult: args.dmarcResult,
			dmarcPolicy: args.dmarcPolicy,
			...sealedFlags,
		});
	},
});

/**
 * Load the recipient's vault private key + the pinned sender public key, then run
 * {@link openSealed}. The vault private key is decrypted from its at-rest
 * envelope with `openPrivateKey` (INSTANCE_SECRET) — it exists only inside this
 * Node action, never in a query result.
 */
async function openWithVault(
	ctx: ActionCtx,
	raw: string,
	recipientAddress: string,
	from: string
): Promise<OpenOutcome> {
	const recipientKey = await ctx.runQuery(internal.e2ee.keys.getAddressKeyInternal, {
		address: recipientAddress,
	});
	if (!recipientKey) return { status: 'cannotDecrypt' };

	let recipientPrivateKeyArmored: string;
	try {
		recipientPrivateKeyArmored = openPrivateKey(recipientKey.sealedPrivateKey);
	} catch {
		return { status: 'cannotDecrypt' };
	}

	const senderPublicKeyArmored = await resolvePinnedSenderKey(ctx, from);

	return openSealed({
		raw,
		recipientPrivateKeysArmored: [recipientPrivateKeyArmored],
		...(senderPublicKeyArmored ? { senderPublicKeyArmored } : {}),
	});
}

/**
 * Resolve the armored PUBLIC key to VERIFY the sender's signature against, per
 * the card ("verify against the discovered/pinned sender key"). A cached
 * `trusted` pin is used directly. On a cache MISS — every first-contact sender —
 * we run the SSRF-guarded, TTL-cached `discoverRecipientKey` ONCE and re-read the
 * freshly persisted pin, so a legitimate first message can be verified instead of
 * being permanently recorded UNVERIFIED. Fail-CLOSED throughout: a `keyChanged`
 * conflict is NEVER silently re-pinned (return undefined ⇒ UNVERIFIED), and any
 * discovery error yields no verification key rather than a false claim.
 */
async function resolvePinnedSenderKey(ctx: ActionCtx, from: string): Promise<string | undefined> {
	const cached = await ctx.runQuery(internal.e2ee.recipientKeys.getCached, { address: from });
	if (cached && cached.outcome === 'trusted') return cached.pinnedPublicKeyArmored;
	// A conflicting (keyChanged) pin must stay UNVERIFIED until an admin resolves
	// it — never discover past it.
	if (cached && cached.outcome === 'keyChanged') return undefined;
	// A fresh negative pin (notFound within TTL) has nothing to verify against and
	// discovery would only return it from cache — skip the Node-action hop entirely.
	if (cached && !shouldRefetch(cached, Date.now())) return undefined;

	// First contact (or an expired negative cache): discover once, then re-read.
	try {
		await ctx.runAction(internal.e2ee.discovery.discoverRecipientKey, { address: from });
	} catch {
		return undefined;
	}
	const rediscovered = await ctx.runQuery(internal.e2ee.recipientKeys.getCached, { address: from });
	return rediscovered && rediscovered.outcome === 'trusted'
		? rediscovered.pinnedPublicKeyArmored
		: undefined;
}

/** Build the honest opened-record from an open outcome + the sender address. */
function buildOpenedInfo(
	outcome: Extract<OpenOutcome, { status: 'opened' }>,
	fromAddress: string
): Extract<InboundEncryptionInfo, { decrypted: true }> {
	const signerInstance = outcome.signatureValid ? instanceOf(fromAddress) : undefined;
	return {
		sealed: true,
		decrypted: true,
		cipherSuite: INBOUND_CIPHER_SUITE,
		signatureValid: outcome.signatureValid,
		...(outcome.signerFingerprint ? { signerFingerprint: outcome.signerFingerprint } : {}),
		...(signerInstance ? { signerInstance } : {}),
	};
}
