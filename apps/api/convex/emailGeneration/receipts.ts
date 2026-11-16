/**
 * One submission, one draft: the receipts of AI draft runs that committed.
 *
 * The web client mints a request id per submission and sends it again when it
 * retries a submission whose outcome it never saw (`useEmailGeneration`). The
 * action looks the id up before admission and the model call, so a repeat
 * spends no rate-limit token and no model call; the commit looks it up again
 * inside its transaction and writes the receipt with the draft, so of two runs
 * with one id only one creates anything and the other returns its result.
 * Concurrent commits are serialized by their read of the id's index range.
 *
 * A receipt answers with the result as first returned, also once the draft
 * has been deleted: the client reuses an id only when it never saw that
 * success, so the answer it lacks is the one it gets.
 *
 * Receipts are scoped to the organization and the member, and kept for
 * {@link RECEIPT_RETENTION_MS}; the hourly purge removes older ones.
 */

import { v } from 'convex/values';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { requireOrgMember } from '../lib/sessionOrganization';
import { DAY_MS } from '../lib/constants';
import type { GenerationOutcome } from './commit';

/** How long a submission's result answers a repeat of it. */
export const RECEIPT_RETENTION_MS = DAY_MS;

/** A plain token: what `crypto.randomUUID()` and similar ids produce. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidRequestId(requestId: string): boolean {
	return REQUEST_ID_PATTERN.test(requestId);
}

const PURGE_BATCH = 200;

export interface ReceiptScope {
	organizationId: string;
	userId: string;
}

async function findReceipt(
	db: QueryCtx['db'],
	scope: ReceiptScope,
	requestId: string
): Promise<Doc<'emailGenerationReceipts'> | null> {
	return await db
		.query('emailGenerationReceipts')
		.withIndex('by_org_user_request', (q) =>
			q
				.eq('organizationId', scope.organizationId)
				.eq('userId', scope.userId)
				.eq('requestId', requestId)
		)
		.first();
}

const outcomeOf = (receipt: Doc<'emailGenerationReceipts'>): GenerationOutcome => ({
	...receipt.result,
	droppedVariables: receipt.droppedVariables,
});

/** The recorded outcome of this member's submission, or null. */
export async function recordedOutcome(
	ctx: QueryCtx,
	scope: ReceiptScope,
	requestId: string
): Promise<GenerationOutcome | null> {
	const receipt = await findReceipt(ctx.db, scope, requestId);
	return receipt ? outcomeOf(receipt) : null;
}

/** Record the outcome, in the transaction that created the draft. */
export async function recordOutcome(
	ctx: MutationCtx,
	scope: ReceiptScope,
	requestId: string,
	outcome: GenerationOutcome
): Promise<void> {
	const { droppedVariables, ...result } = outcome;
	await ctx.db.insert('emailGenerationReceipts', {
		organizationId: scope.organizationId,
		userId: scope.userId,
		requestId,
		result,
		droppedVariables,
		createdAt: Date.now(),
	});
}

/** The action's lookup before admission. Advisory: the commit looks again and decides. */
export const lookup = internalQuery({
	args: { requestId: v.string() },
	handler: async (ctx, args): Promise<GenerationOutcome | null> => {
		const session = await requireOrgMember(ctx);
		return await recordedOutcome(
			ctx,
			{ organizationId: session.activeOrganizationId, userId: session.userId },
			args.requestId
		);
	},
});

/** Delete receipts past their retention in bounded batches, continuing while a batch comes back full. */
export const purgeExpired = internalMutation({
	args: {},
	handler: async (ctx): Promise<number> => {
		const expired = await ctx.db
			.query('emailGenerationReceipts')
			.withIndex('by_created_at', (q) => q.lt('createdAt', Date.now() - RECEIPT_RETENTION_MS))
			.take(PURGE_BATCH);
		for (const receipt of expired) await ctx.db.delete(receipt._id);
		if (expired.length === PURGE_BATCH) {
			await ctx.scheduler.runAfter(0, internal.emailGeneration.receipts.purgeExpired, {});
		}
		return expired.length;
	},
});
