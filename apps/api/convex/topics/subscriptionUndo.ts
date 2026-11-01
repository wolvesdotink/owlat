/**
 * Topic subscription — the inverses of an operator's bulk edit.
 *
 * The bodies of `revertSubscribeMany` and `restoreMemberships`, which stay
 * registered in `subscription.ts`; its "Undo of a bulk edit" section and their
 * docs say what each undoes and what it leaves alone.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { AddedMembership, RemovedMembership } from './subscriptionContract';
import { patchCachedMemberCountDelta } from './subscriptionOps';

async function findReceiptedMembership(
	ctx: MutationCtx,
	topicId: Id<'topics'>,
	receipt: AddedMembership
): Promise<Doc<'contactTopics'> | null> {
	const original = await ctx.db.get(receipt.membershipId);
	if (original) return original.topicId === topicId ? original : null;
	const current = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact_and_topic', (q) =>
			q.eq('contactId', receipt.contactId).eq('topicId', topicId)
		)
		.first();
	return current?.restoredFrom === receipt.membershipId ? current : null;
}

/** Undo a `subscribeMany` from its receipt; the body of `revertSubscribeMany`. */
export async function revertAddedMemberships(
	ctx: MutationCtx,
	args: { topicId: Id<'topics'>; added: AddedMembership[] }
): Promise<{ reverted: number }> {
	const topic = await ctx.db.get(args.topicId);
	if (!topic) return { reverted: 0 };

	const now = Date.now();
	let reverted = 0;
	for (const receipt of args.added) {
		const membership = await findReceiptedMembership(ctx, args.topicId, receipt);
		if (!membership) continue;
		await ctx.db.delete(membership._id);
		reverted += 1;

		if (receipt.liftedOptOutAt === undefined) continue;
		const contact = await ctx.db.get(membership.contactId);
		if (contact && contact.unsubscribedAt === undefined) {
			await ctx.db.patch(contact._id, {
				unsubscribedAt: Math.min(receipt.liftedOptOutAt, now),
			});
		}
	}

	await patchCachedMemberCountDelta(ctx, topic, -reverted, now);
	return { reverted };
}

/** Undo an `unsubscribeMany` from its receipt; the body of `restoreMemberships`. */
export async function restoreRemovedMemberships(
	ctx: MutationCtx,
	args: { topicId: Id<'topics'>; removed: RemovedMembership[] }
): Promise<{ restored: number }> {
	const topic = await ctx.db.get(args.topicId);
	if (!topic) return { restored: 0 };

	const now = Date.now();
	let restored = 0;
	for (const receipt of args.removed) {
		const contact = await ctx.db.get(receipt.contactId);
		if (!contact || contact.deletedAt !== undefined) continue;
		const existing = await ctx.db
			.query('contactTopics')
			.withIndex('by_contact_and_topic', (q) =>
				q.eq('contactId', receipt.contactId).eq('topicId', args.topicId)
			)
			.first();
		if (existing) continue;

		const stillPending =
			receipt.pendingDoiConfirmation === true && contact.doiStatus !== 'confirmed';
		await ctx.db.insert('contactTopics', {
			contactId: receipt.contactId,
			topicId: args.topicId,
			addedAt: Math.min(receipt.addedAt, now),
			restoredFrom: receipt.membershipId,
			...(stillPending ? { pendingDoiConfirmation: true } : {}),
			...(receipt.seedTag !== undefined ? { seedTag: receipt.seedTag } : {}),
		});
		restored += 1;
	}

	await patchCachedMemberCountDelta(ctx, topic, restored, now);
	return { restored };
}
