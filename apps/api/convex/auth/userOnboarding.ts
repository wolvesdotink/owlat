import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { requireSelf } from '../lib/sessionOrganization';

/**
 * Per-user first-login onboarding state.
 *
 * This is the PER-USER counterpart to the instance-wide admin onboarding in
 * `auth/onboarding.ts` (do not conflate them): it records where one member is in
 * their personal setup journey. Each step is a completion timestamp on the
 * member's `userOnboarding` row, keyed by their BetterAuth `authUserId`.
 *
 * Steps are written idempotently from the real product flows via
 * {@link markOnboardingStep} — no polling, no client-driven progress. A user can
 * only ever read or write THEIR OWN row (`requireSelf`); there is no cross-user
 * read path here. The consuming UI (piece c1) subscribes to `get`.
 */

/** The onboarding steps that can be marked complete from product flows. */
export type OnboardingStep =
	| 'mailboxReady'
	| 'importStarted'
	| 'importDone'
	| 'knowledgeIndexed'
	| 'sendingSwitched'
	| 'firstSendDone';

/**
 * Idempotently record that `authUserId` reached `step`, stamping the completion
 * time on first occurrence and leaving an already-set timestamp untouched (so
 * the first-completion instant is preserved across replays / retries). Upserts
 * the row on first write.
 *
 * This is a plain `ctx.db` helper, not a Convex function — call it directly from
 * inside the mutation that owns the flow (mailbox claim/connect, migration
 * start/complete, indexing complete, sending switch, first send). It never
 * throws on an already-completed step.
 */
export async function markOnboardingStep(
	ctx: MutationCtx,
	authUserId: string,
	step: OnboardingStep
): Promise<void> {
	const now = Date.now();
	const stepPatch: Partial<Record<OnboardingStep, number>> = { [step]: now };
	const existing = await ctx.db
		.query('userOnboarding')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.first();

	if (!existing) {
		await ctx.db.insert('userOnboarding', {
			authUserId,
			...stepPatch,
			createdAt: now,
			updatedAt: now,
		});
		return;
	}

	// Preserve the first-completion timestamp: only the initial write for a step
	// counts, later flow replays are no-ops for that field.
	if (existing[step] !== undefined) return;
	await ctx.db.patch(existing._id, { ...stepPatch, updatedAt: now });
}

/** Shape returned to the consuming UI — always a concrete object, never null. */
type OnboardingState = {
	mailboxReady: number | null;
	importStarted: number | null;
	importDone: number | null;
	knowledgeIndexed: number | null;
	sendingSwitched: number | null;
	firstSendDone: number | null;
	dismissedAt: number | null;
};

const EMPTY_STATE: OnboardingState = {
	mailboxReady: null,
	importStarted: null,
	importDone: null,
	knowledgeIndexed: null,
	sendingSwitched: null,
	firstSendDone: null,
	dismissedAt: null,
};

/**
 * Read the caller's own onboarding checklist. Returns a fully-populated object
 * (all steps `null`) when the member has no row yet, so the UI never has to
 * distinguish "no row" from "nothing done".
 */
// authz: self — requireSelf asserts args.userId is the caller.
export const get = authedQuery({
	args: {
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<OnboardingState> => {
		await requireSelf(ctx, args.userId);

		const row = await ctx.db
			.query('userOnboarding')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', args.userId))
			.first();
		if (!row) return { ...EMPTY_STATE };

		return {
			mailboxReady: row.mailboxReady ?? null,
			importStarted: row.importStarted ?? null,
			importDone: row.importDone ?? null,
			knowledgeIndexed: row.knowledgeIndexed ?? null,
			sendingSwitched: row.sendingSwitched ?? null,
			firstSendDone: row.firstSendDone ?? null,
			dismissedAt: row.dismissedAt ?? null,
		};
	},
});

/**
 * Dismiss the caller's own onboarding checklist. Per-user only — hides the
 * surface for this member, never for anyone else. Upserts the row on first
 * write and is idempotent (re-dismissing refreshes the timestamp).
 */
// authz: self — requireSelf asserts args.userId is the caller.
export const dismiss = authedMutation({
	args: {
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);

		const now = Date.now();
		const existing = await ctx.db
			.query('userOnboarding')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', args.userId))
			.first();

		if (!existing) {
			await ctx.db.insert('userOnboarding', {
				authUserId: args.userId,
				dismissedAt: now,
				createdAt: now,
				updatedAt: now,
			});
			return;
		}
		await ctx.db.patch(existing._id, { dismissedAt: now, updatedAt: now });
	},
});
