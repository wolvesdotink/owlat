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
 * the `key_changed` refusal, never the old verdict. A key that was not found is
 * not written either: the key cache records a failed WKD lookup as a miss like
 * any other, so the row stays unscoped and a later open tries again, under the
 * rate limit (and the key cache's own negative TTL before any fetch).
 *
 * A scope can change what interpretation reads: a clearsigned scope narrows the
 * body to the signed block, so the unsigned text around it and an HTML
 * alternative no longer count. What the old read took from them is spread
 * over the thread's brief, so the whole thread's interpretation is fenced off
 * in the same write (`interpret/staleFence.ts`), whether or not a new read
 * could run. A run of the old read still in flight is refused by the body
 * fingerprint (`interpret/sourceVersion.ts`).
 */

import { v } from 'convex/values';
import { internalAction, internalQuery } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { internal } from '../../_generated/api';
import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { interpretationSourceKey } from '../../lib/validators/threadBrief';
import { inboundSignatureInfoValidator } from '../../e2ee/inboundSignature';
import { readSealedBlobBytes } from '../../lib/sealedBlob';
import { bytesToBase64 } from '../../lib/bytes';
import { rateLimiter } from '../../lib/rateLimiter';
import { logError } from '../../lib/runtimeLog';
import { postboxMutation } from '../_helpers';
import { requireMailboxAccess } from '../permissions';
import { isMailReadChangedBy } from '../interpret/scopeLoad';
import { fenceThreadInterpretation } from '../interpret/staleFence';
import { refreshArrivalProjection } from '../arrival/projection';
import { clearColdPitchOfMessage } from '../arrival/coldPitch';

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
		// No signature the current gates recognise, the verifier failed, or no
		// key was found (perhaps only for now): nothing settled to show, so the
		// row keeps its neutral state and a later open tries again.
		if (!verdict.isSigned || !isSettledVerdict(verdict.info)) return null;
		let isReadChanged: boolean;
		try {
			isReadChanged = await isMailReadChangedBy(ctx, args.messageId, verdict.info);
		} catch (err) {
			// Unsure: re-reading costs a model call, a stale read costs wrong claims.
			logError('[Signature reverify] interpretation read check failed', err);
			isReadChanged = true;
		}
		await ctx.runMutation(internal.mail.mailbox.signatureReverify.apply, {
			messageId: args.messageId,
			info: verdict.info,
			isReadChanged,
		});
		return null;
	},
});

/** A verdict worth keeping: the verifier ran to an answer that holds for now. */
function isSettledVerdict(info: { failure?: string; keySource: string }): boolean {
	return info.failure !== 'verification_error' && info.keySource !== 'not_found';
}

/**
 * Replace the unscoped verdict with the re-verified one. Compare-and-set: a row
 * that meanwhile got a scoped verdict (a concurrent run) is left alone, and an
 * unscoped verdict is never written. When the new scope changes what
 * interpretation reads (`isReadChanged`) and the message was interpreted, its
 * thread's interpretation is fenced off in the same transaction. A changed
 * read also clears the message's cold-pitch verdict (#1381), which R2 judged
 * on the old read whether or not a full interpretation exists; an R2 answer
 * still in flight is refused by the body fingerprint.
 */
export const apply = internalMutation({
	args: {
		messageId: v.id('mailMessages'),
		info: inboundSignatureInfoValidator,
		isReadChanged: v.boolean(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if (args.info.scope === undefined || !isSettledVerdict(args.info)) return null;
		const message = await ctx.db.get(args.messageId);
		if (!message || !needsSignatureReverify(message)) return null;
		await ctx.db.patch(args.messageId, { inboundSignatureInfo: args.info, updatedAt: Date.now() });
		if (!args.isReadChanged) return null;
		const isFenced = await isInterpreted(ctx, message);
		if (isFenced) await fenceThreadInterpretation(ctx, message.threadId);
		const isPitchCleared = await clearColdPitchOfMessage(ctx, args.messageId);
		// The arrival projection reads both the fence and the verdict (#1381).
		if (isFenced || isPitchCleared) await refreshArrivalProjection(ctx, message.threadId);
		return null;
	},
});

/**
 * Did a read of the message contribute to its thread's interpretation? A
 * Postbox message is read as received (`mail:`) or, filed in Sent and read by
 * the history pass, as sent (`outboundMail:`): either counts.
 */
async function isInterpreted(ctx: MutationCtx, message: Doc<'mailMessages'>): Promise<boolean> {
	for (const kind of ['mail', 'outboundMail'] as const) {
		const sourceKey = interpretationSourceKey({ kind, id: message._id });
		const extraction = await ctx.db
			.query('messageInterpretations')
			.withIndex('by_source_revision', (q) => q.eq('sourceKey', sourceKey))
			.first();
		if (extraction) return true;
	}
	return false;
}
