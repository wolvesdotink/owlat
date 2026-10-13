/**
 * Re-verify a signed message whose verdict predates verdict scopes (#1320).
 *
 * Since #1316 every inbound signature verdict records what it covers
 * (`InboundSignatureInfo.scope`), and the reader withholds any verdict without
 * one. Rows verified before that keep an unscoped verdict nobody sees. When the
 * reader opens such a message it calls {@link request}, which runs the CURRENT
 * verifier (`e2ee/verifyInboundSignature.forInbound`, the PGP/MIME structure
 * cross-check included) over the stored raw `.eml` and replaces the old verdict
 * with the scoped one it returns.
 *
 * Lazy rather than a backfill: the work follows what people actually open, and
 * each message costs at most one verification per rate-limit window.
 *
 * Fail-closed: only a verdict the current verifier produced is written, and it
 * is written whatever it says (a tampered or no-longer-matching message gets
 * its scoped "not verified"). The old verdict is never promoted. When no
 * verdict can be produced (the raw message is gone, the verifier no longer
 * sees a signature, the verifier itself failed) the row is left as it is, and
 * the reader keeps showing the neutral state.
 *
 * The key is the one the instance holds now (the TOFU pin, or fresh discovery),
 * the same ladder ingest uses today: a key that changed since delivery yields
 * the `key_changed` refusal, never the old verdict.
 */

import { v } from 'convex/values';
import { internalAction, internalQuery } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { internal } from '../../_generated/api';
import type { Doc } from '../../_generated/dataModel';
import { inboundSignatureInfoValidator } from '../../e2ee/inboundSignature';
import { readSealedBlobBytes } from '../../lib/sealedBlob';
import { bytesToBase64 } from '../../lib/bytes';
import { rateLimiter } from '../../lib/rateLimiter';
import { logError } from '../../lib/runtimeLog';
import { postboxMutation } from '../_helpers';
import { requireMailboxAccess } from '../permissions';

/** A signed plaintext row whose verdict has no scope, so the reader withholds it. */
export function needsSignatureReverify(
	message: Pick<Doc<'mailMessages'>, 'inboundSignatureInfo' | 'inboundEncryptionInfo'>
): boolean {
	const info = message.inboundSignatureInfo;
	return !!info && info.scope === undefined && message.inboundEncryptionInfo === undefined;
}

/**
 * The reader opened a message carrying an unscoped verdict: queue its
 * re-verification. A no-op for every other message, for a caller who cannot
 * read the mailbox, and within the per-message rate-limit window.
 */
export const request = postboxMutation({
	args: { messageId: v.id('mailMessages') },
	returns: v.null(),
	handler: async (ctx, args, session) => {
		const message = await ctx.db.get(args.messageId);
		if (!message) return null;
		const access = await requireMailboxAccess(ctx, message.mailboxId, 'member', session);
		if (!access.ok || !needsSignatureReverify(message)) return null;
		const limit = await rateLimiter.limit(ctx, 'signatureReverify', { key: args.messageId });
		if (!limit.ok) return null;
		await ctx.scheduler.runAfter(0, internal.mail.mailbox.signatureReverify.run, {
			messageId: args.messageId,
		});
		return null;
	},
});

/** What {@link run} needs from the row, or null once it no longer needs re-verifying. */
export const loadTarget = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.messageId);
		if (!message || !needsSignatureReverify(message)) return null;
		return { rawStorageId: message.rawStorageId, fromAddress: message.fromAddress };
	},
});

/** Verify the stored raw message again and keep the verdict when there is one. */
export const run = internalAction({
	args: { messageId: v.id('mailMessages') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const target = await ctx.runQuery(internal.mail.mailbox.signatureReverify.loadTarget, args);
		if (!target) return null;
		let raw: Uint8Array | null;
		try {
			raw = await readSealedBlobBytes(ctx.storage, target.rawStorageId);
		} catch (err) {
			logError('[Signature reverify] raw message unreadable', err);
			return null;
		}
		if (raw === null) return null;
		let verdict;
		try {
			verdict = await ctx.runAction(internal.e2ee.verifyInboundSignature.forInbound, {
				rawBytesBase64: bytesToBase64(raw),
				from: target.fromAddress,
			});
		} catch (err) {
			logError('[Signature reverify] verifier failed', err);
			return null;
		}
		// No signature the current gates recognise, or the verifier failed: no
		// verdict to show, so the row keeps its neutral state.
		if (!verdict.isSigned || verdict.info.failure === 'verification_error') return null;
		await ctx.runMutation(internal.mail.mailbox.signatureReverify.apply, {
			messageId: args.messageId,
			info: verdict.info,
		});
		return null;
	},
});

/**
 * Replace the unscoped verdict with the re-verified one. Compare-and-set: a row
 * that meanwhile got a scoped verdict (a concurrent run) is left alone, and an
 * unscoped verdict is never written.
 */
export const apply = internalMutation({
	args: { messageId: v.id('mailMessages'), info: inboundSignatureInfoValidator },
	returns: v.null(),
	handler: async (ctx, args) => {
		if (args.info.scope === undefined) return null;
		const message = await ctx.db.get(args.messageId);
		if (!message || !needsSignatureReverify(message)) return null;
		await ctx.db.patch(args.messageId, { inboundSignatureInfo: args.info, updatedAt: Date.now() });
		return null;
	},
});
