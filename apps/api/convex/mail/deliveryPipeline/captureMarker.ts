/**
 * The attachment-indexing marker a capture outcome renders as, shared by both
 * inbound routes: the Team Inbox row (`inboundMessages.attachmentIndexing`)
 * and the Postbox message (`mailMessages.attachmentIndexing`). Without a
 * marker a file the assistant never read looks exactly like one it read, so
 * every skip is recorded, the L6 gates (`captureGate.ts`) included.
 */

import { v } from 'convex/values';
import { internalMutation } from '../../lib/writeFence';
import { attachmentIndexingValidator, type AttachmentIndexing } from '../../lib/literalValidators';
import type { AttachmentCaptureOutcome } from './capture';
import { literalUnion } from '../../lib/literalUnion';

/**
 * The marker each skip reason renders as. A TOTAL table: `satisfies` makes a
 * new skip reason a compile error here instead of a row that silently renders
 * as though the assistant had read the file.
 */
const SKIP_MARKERS = {
	spam: 'skipped_spam',
	automated: 'skipped_automated',
	unverified: 'skipped_unverified',
	budget: 'skipped_budget',
	unscanned: 'skipped_unscanned',
	cap: 'skipped_cap',
	refused_type: 'skipped_refused_type',
	too_large: 'skipped_too_large',
	unsupported_type: 'skipped_unsupported',
} as const satisfies Record<
	NonNullable<AttachmentCaptureOutcome['skippedReason']>,
	AttachmentIndexing
>;

type CaptureSkipReason = NonNullable<AttachmentCaptureOutcome['skippedReason']>;

/**
 * A capture skip reason as a validator, from the same total table: the
 * webhook's plan hands its reason for the parts it left out to the scheduled
 * step (`deferredCapture.ts` `stagedCaptureArgs.skippedReason`).
 */
export const captureSkipReasonValidator = literalUnion(
	Object.keys(SKIP_MARKERS) as CaptureSkipReason[]
);

/**
 * Which single line this outcome renders as, or none (nothing to capture).
 * A skip outranks the placeholder note: "the assistant has not read some of
 * these" is the stronger sentence, and only one line is rendered.
 */
export function indexingMarkerOf(
	outcome: AttachmentCaptureOutcome
): AttachmentIndexing | undefined {
	if (outcome.skippedReason) return SKIP_MARKERS[outcome.skippedReason];
	if (outcome.indexed === 0) return undefined;
	return outcome.namesOnly ? 'indexed_placeholder' : 'indexed';
}

/** Record a Postbox message's capture outcome (a message gone meanwhile is skipped). */
export const setMailAttachmentIndexing = internalMutation({
	args: { mailMessageId: v.id('mailMessages'), attachmentIndexing: attachmentIndexingValidator },
	handler: async (ctx, args) => {
		if (!(await ctx.db.get(args.mailMessageId))) return;
		await ctx.db.patch(args.mailMessageId, { attachmentIndexing: args.attachmentIndexing });
	},
});
