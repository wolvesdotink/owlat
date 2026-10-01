/**
 * Form submission (module): the rows that wait on a confirmation token.
 *
 * A `pending_confirmation` row stores the contact's DOI token. Two things
 * happen to those rows besides the insert in `submission.ts`:
 *   - the contact confirms, and `markConfirmedByToken` finalizes them through
 *     `finalizeSubmissions` here;
 *   - the contact's token is replaced (an admin resend, or a new signup after
 *     the token lapsed), and `carryPendingSubmissions` moves them to the new
 *     token so the next confirmation finalizes them too.
 *
 * A token a global opt-out withdrew is never carried: the contact no longer
 * holds it when the next token is minted, so nothing names it as outgoing.
 *
 * See docs/adr/0015-form-submission-module.md.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';

/** Rows moved per mutation; the rest continue in a scheduled follow-up. */
const CARRY_BATCH = 100;

/**
 * Patch rows `pending_confirmation → success` and bump each form's success
 * count once per row. Returns how many rows it finalized.
 */
export async function finalizeSubmissions(
	ctx: MutationCtx,
	submissions: ReadonlyArray<Doc<'formSubmissions'>>,
	at: number,
	patch: { confirmationToken?: string } = {}
): Promise<number> {
	const confirmedPerForm = new Map<Id<'formEndpoints'>, number>();
	for (const submission of submissions) {
		await ctx.db.patch(submission._id, { ...patch, status: 'success', confirmedAt: at });
		const formId = submission.formEndpointId;
		confirmedPerForm.set(formId, (confirmedPerForm.get(formId) ?? 0) + 1);
	}
	for (const [formId, confirmed] of confirmedPerForm) {
		const form = await ctx.db.get(formId);
		if (form) {
			await ctx.db.patch(formId, {
				successfulSubmissionCount: (form.successfulSubmissionCount ?? 0) + confirmed,
			});
		}
	}
	return submissions.length;
}

type CarryTarget =
	| { kind: 'move'; token: string }
	| { kind: 'finalize'; at: number }
	| { kind: 'stop' };

/**
 * Where the rest of a carry goes, read from the contact at the time the page
 * runs. The first page runs in the transaction that replaced the token, so the
 * contact holds `toToken`. A scheduled follow-up can find the token moved on:
 *   - replaced again: that replacement carried `toToken`'s rows already, so
 *     these go straight to the token the contact holds now;
 *   - spent on a confirmation: these finalize as that confirmation would have;
 *   - withdrawn by a global opt-out, or the contact gone: they stay put.
 */
function carryTarget(contact: Doc<'contacts'> | null, fromToken: string): CarryTarget {
	if (!contact) return { kind: 'stop' };
	const token = contact.doiConfirmationToken;
	if (contact.doiStatus === 'pending' && token !== undefined) {
		return token === fromToken ? { kind: 'stop' } : { kind: 'move', token };
	}
	if (contact.doiStatus === 'confirmed' && token === undefined) {
		return { kind: 'finalize', at: contact.doiConfirmedAt ?? Date.now() };
	}
	return { kind: 'stop' };
}

const carryArgsValidator = {
	contactId: v.id('contacts'),
	// The token the contact held before the replacement.
	fromToken: v.string(),
	// The token that replaced it.
	toToken: v.string(),
	// Continuation state, set only by the scheduled follow-up.
	cursor: v.optional(v.string()),
};

/**
 * Move a contact's `pending_confirmation` rows from `fromToken` to the token
 * that replaced it. Called by the DOI lifecycle in the transaction that writes
 * the new token, after the contact patch. Rows of other contacts and rows in
 * any other status keep their token.
 */
export const carryPendingSubmissions = internalMutation({
	args: carryArgsValidator,
	handler: async (
		ctx,
		args
	): Promise<{ carried: number; finalized: number; continued: boolean }> => {
		const target = carryTarget(await ctx.db.get(args.contactId), args.fromToken);
		if (target.kind === 'stop') return { carried: 0, finalized: 0, continued: false };

		const page = await ctx.db
			.query('formSubmissions')
			.withIndex('by_confirmation_token_and_status', (q) =>
				q.eq('confirmationToken', args.fromToken).eq('status', 'pending_confirmation')
			)
			.paginate({ cursor: args.cursor ?? null, numItems: CARRY_BATCH });
		const rows = page.page.filter((submission) => submission.contactId === args.contactId);

		let carried = 0;
		let finalized = 0;
		if (target.kind === 'move') {
			for (const submission of rows) {
				await ctx.db.patch(submission._id, { confirmationToken: target.token });
			}
			carried = rows.length;
		} else {
			finalized = await finalizeSubmissions(ctx, rows, target.at, {
				confirmationToken: args.toToken,
			});
		}

		const continued = !page.isDone;
		if (continued) {
			await ctx.scheduler.runAfter(0, internal.forms.pendingConfirmations.carryPendingSubmissions, {
				contactId: args.contactId,
				fromToken: args.fromToken,
				toToken: target.kind === 'move' ? target.token : args.toToken,
				cursor: page.continueCursor,
			});
		}
		return { carried, finalized, continued };
	},
});
