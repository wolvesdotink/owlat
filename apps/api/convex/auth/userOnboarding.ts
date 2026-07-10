import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { requireSelf } from '../lib/sessionOrganization';
import { throwInvalidState } from '../_utils/errors';

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

/**
 * The onboarding steps that can be marked complete from product flows. Single
 * source of truth: the union type, the empty-state, and the `get` response are
 * all derived from this list, so adding `sendingSwitched`/`firstSendDone` write
 * points (or a new step) is a one-place change here plus the schema field.
 */
export const ONBOARDING_STEPS = [
	'mailboxReady',
	'importStarted',
	'importDone',
	'knowledgeIndexed',
	'sendingSwitched',
	'firstSendDone',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * Upsert the caller's onboarding row with `patch`, stamping `createdAt` on the
 * first write and refreshing `updatedAt` on every write. Shared by
 * {@link markOnboardingStep} and {@link dismiss}; neither the step guard nor the
 * authz check live here — callers apply those before calling.
 */
async function upsertOnboardingRow(
	ctx: MutationCtx,
	authUserId: string,
	patch: Partial<Record<OnboardingStep | 'dismissedAt' | 'welcomedAt', number>>
): Promise<void> {
	const now = Date.now();
	const existing = await ctx.db
		.query('userOnboarding')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.first();

	if (!existing) {
		await ctx.db.insert('userOnboarding', {
			authUserId,
			...patch,
			createdAt: now,
			updatedAt: now,
		});
		return;
	}
	await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
}

/**
 * Idempotently stamp a single timestamp `field` on the caller's onboarding row,
 * writing `Date.now()` only the first time and leaving an already-set value
 * untouched (so the first-occurrence instant is preserved across replays /
 * retries). Upserts the row on first write.
 *
 * Shared by {@link markOnboardingStep} (per-step completion) and
 * {@link markWelcomed} (the welcome-seen stamp); neither the step guard nor the
 * authz check live here — callers apply those before calling.
 */
async function stampOnce(
	ctx: MutationCtx,
	authUserId: string,
	field: OnboardingStep | 'welcomedAt'
): Promise<void> {
	const existing = await ctx.db
		.query('userOnboarding')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.first();

	// Preserve the first-occurrence timestamp: only the initial write for a field
	// counts, later replays are no-ops for that field.
	if (existing && existing[field] !== undefined) return;

	await upsertOnboardingRow(ctx, authUserId, { [field]: Date.now() });
}

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
	await stampOnce(ctx, authUserId, step);
}

/** Shape returned to the consuming UI — always a concrete object, never null. */
type OnboardingState = Record<OnboardingStep | 'dismissedAt' | 'welcomedAt', number | null>;

const EMPTY_STATE: OnboardingState = Object.fromEntries(
	[...ONBOARDING_STEPS, 'dismissedAt' as const, 'welcomedAt' as const].map(
		(key) => [key, null] as const
	)
) as OnboardingState;

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

		const state = { ...EMPTY_STATE };
		for (const step of ONBOARDING_STEPS) state[step] = row[step] ?? null;
		state.dismissedAt = row.dismissedAt ?? null;
		state.welcomedAt = row.welcomedAt ?? null;
		return state;
	},
});

/**
 * Finish the fresh-start welcome: mark the caller's `mailboxReady` step once a
 * live personal mailbox actually exists. The welcome flow provisions/claims the
 * mailbox through its own flows (which already mark the step), so this is the
 * belt-and-suspenders write that guarantees "completed the welcome ⇒
 * mailboxReady" even for a mailbox that was provisioned at invite-accept time.
 * Refuses when the caller has no mailbox — the step must never be a lie.
 */
// authz: self — requireSelf asserts args.userId is the caller.
export const completeFreshStart = authedMutation({
	args: {
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		const mailbox = await ctx.db
			.query('mailboxes')
			.withIndex('by_user', (q) => q.eq('userId', args.userId))
			.filter((q) => q.eq(q.field('status'), 'active'))
			.first();
		if (!mailbox) throwInvalidState('No mailbox yet');
		await markOnboardingStep(ctx, args.userId, 'mailboxReady');
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
		await upsertOnboardingRow(ctx, args.userId, { dismissedAt: Date.now() });
	},
});

/**
 * Record that the caller has seen the first-login welcome screen. Written once,
 * the first time the member lands on `/welcome`; the timestamp is preserved on
 * replays so the first-seen instant is stable. This is what flips a member from
 * "new" to "returning" for the welcome middleware — a returning user (any row
 * with `welcomedAt` set) is never routed to `/welcome` again. Upserts the row on
 * first write. Per-user only.
 */
// authz: self — requireSelf asserts args.userId is the caller.
export const markWelcomed = authedMutation({
	args: {
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		await stampOnce(ctx, args.userId, 'welcomedAt');
	},
});
