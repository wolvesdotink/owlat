/**
 * The one writer for provider-sourced suppressions, and the block source type
 * it shares with the operator's manual block in `blocklist.ts`.
 */
import { v, type ObjectType } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { normalizeEmail } from '../lib/inputGuards';
import * as sm from '../delivery/suppressionMirrorScheduler';
import { recordAuditLog } from '../lib/auditLog';
import { bounceTypeValidator, manualOrEventBlockReasonValidator } from '../lib/literalValidators';
import { findBlockedByEmail, wasRemovedByOperatorSince } from './lookup';

// Derive the polymorphic block `sourceType` from whichever source-send id was
// supplied (emailSend vs transactionalSend), or undefined for a manual block.
export function deriveBlockSourceType(source: {
	sourceEmailSendId?: Id<'emailSends'>;
	sourceTransactionalSendId?: Id<'transactionalSends'>;
}): 'emailSend' | 'transactionalSend' | undefined {
	return source.sourceEmailSendId
		? 'emailSend'
		: source.sourceTransactionalSendId
			? 'transactionalSend'
			: undefined;
}

/** `addFromEvent`'s arguments. */
export const addFromEventArgs = {
	email: v.string(),
	reason: manualOrEventBlockReasonValidator,
	bounceType: v.optional(bounceTypeValidator),
	sourceEmailSendId: v.optional(v.id('emailSends')),
	sourceTransactionalSendId: v.optional(v.id('transactionalSends')),
	provenance: v.optional(
		v.object({
			/** Send-provider kind the suppression came from, e.g. `mandrill`. */
			provider: v.string(),
			/**
			 * Ongoing feedback, a provider's refusal in its own send response, or
			 * a one-off carry-over of an existing list.
			 */
			source: v.union(v.literal('webhook'), v.literal('send_response'), v.literal('import')),
			/** The provider's own reason code, e.g. `MANDRILL_REJECT_SPAM`. */
			evidence: v.optional(v.string()),
		})
	),
	/**
	 * When the provider observed this, for a provider-reported event. A re-add
	 * older than an operator's removal of the address is refused (returns
	 * null), so a late or replayed event cannot undo it. See
	 * `wasRemovedByOperatorSince` for the tie rule and the cases it refuses
	 * without proof.
	 */
	eventAt: v.optional(v.number()),
};

// THE ONE WRITER FOR PROVIDER-SOURCED SUPPRESSIONS: the redacted-complaint path
// (`webhooks/complaintDispatch.ts`), the provider suppression paths
// (`webhooks/providerSuppression.ts`) and the suppression IMPORT that carries a
// migrating deployment's Mandrill/Mailchimp list over
// (`integrationImports/suppressions.ts`) all write through it, so that "already
// blocked ⇒ no second row, no second mirror, no second audit entry" is decided
// once rather than once per ingress.
//
//   - `reason` accepts `'manual'`, the class an operator-curated blacklist
//     entry belongs to (Mandrill `custom`). A Mandrill `rule` reject blocks no
//     one; older rows from one carry `MANDRILL_REJECT_RULE` as the evidence of
//     their `blocklist.provider_suppressed` audit entry, for as long as audit
//     retention keeps that entry (30 days).
//   - `bounceType` is carried through to the row AND to the MTA mirror, where
//     it decides permanent (`hard_bounce`) vs. expiring (`manual`) backstop
//     entries — a soft-bounce suppression that mirrored as hard would be
//     unrecoverable at the last hop.
//   - `provenance` names WHO caused the suppression, and its presence is what
//     turns on the audit entry. The lifecycle-effect callers have a Send row to
//     explain themselves with; a provider blacklist hit or a bulk import has
//     nothing on the suppression screen to say where the address came from.
export const addFromEvent = internalMutation({
	args: addFromEventArgs,
	handler: async (ctx, args) => await addProviderSuppression(ctx, args),
});

/** The body of `addFromEvent`. */
export async function addProviderSuppression(
	ctx: MutationCtx,
	args: ObjectType<typeof addFromEventArgs>
): Promise<Id<'blockedEmails'> | null> {
	const normalizedEmail = normalizeEmail(args.email);

	// Check if already blocked - if so, don't add duplicate
	const existing = await findBlockedByEmail(ctx, normalizedEmail);

	if (existing) {
		// Already blocked, just return the existing ID. A replayed webhook batch
		// or a re-run import therefore writes NOTHING — no row, no mirror, and
		// (below) no audit entry, because an audit trail records state changes
		// and this call changed no state.
		return existing._id;
	}

	if (
		args.eventAt !== undefined &&
		(await wasRemovedByOperatorSince(ctx, normalizedEmail, args.eventAt))
	) {
		return null;
	}

	// Create the blocked email record
	const sourceType = deriveBlockSourceType(args);
	const blockedEmailId = await ctx.db.insert('blockedEmails', {
		email: normalizedEmail,
		reason: args.reason,
		...(args.bounceType ? { bounceType: args.bounceType } : {}),
		sourceType,
		sourceEmailSendId: args.sourceEmailSendId,
		sourceTransactionalSendId: args.sourceTransactionalSendId,
		createdAt: Date.now(),
	});

	if (args.provenance) {
		await recordAuditLog(ctx, {
			userId: `system:${args.provenance.provider}_${args.provenance.source}`,
			action: 'blocklist.provider_suppressed',
			resource: 'blocklist',
			resourceId: blockedEmailId,
			details: {
				email: normalizedEmail,
				reason: args.reason,
				provider: args.provenance.provider,
				source: args.provenance.source,
				...(args.bounceType ? { bounceType: args.bounceType } : {}),
				...(args.provenance.evidence ? { evidence: args.provenance.evidence } : {}),
			},
		});
	}

	// Mirror provider-webhook bounce/complaint suppressions to the MTA's
	// Redis backstop (Resend/SES events land here, never on the MTA list
	// otherwise). Fire-and-forget; never rolls back the insert.
	await sm.scheduleSuppressionMirror(ctx, {
		email: normalizedEmail,
		reason: args.reason,
		...(args.bounceType ? { bounceType: args.bounceType } : {}),
	});

	return blockedEmailId;
}
