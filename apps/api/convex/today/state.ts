/**
 * The Workbench's per-member state: the "since you last looked" watermarks
 * (one global, one per Workbench) and the inboxes the member left out.
 *
 * Each Workbench reports what arrived and what moved in one mailbox since
 * its watermark. It is per user (a shared inbox has shared read flags, so
 * those cannot say what THIS person has already seen) and it only moves on
 * purpose: the explicit "Mark as seen", finishing the Answer queue, or a
 * deliberate dwell on that Workbench. Nothing here reads mail.
 *
 * The inbox choice is per person too. Two members of the support inbox can
 * disagree: one wants its Workbench, the other works it from the Answer queue
 * and keeps their Workbench tabs to their own mail.
 */

import { v } from 'convex/values';
import { throwForbidden } from '../_utils/errors';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { requireMailboxAccess } from '../mail/permissions';

/** With no watermark yet, a Workbench looks back this far. */
export const FIRST_VISIT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Bound on the hide list; far above any real number of readable inboxes. */
const MAX_HIDDEN_MAILBOXES = 100;
/** Bound on per-Workbench marks, for the same reason. */
const MAX_MARKS = 100;

/** One Workbench: a mailbox, or the team inbox. Absent = the global watermark. */
const scopeValidator = v.optional(v.union(v.id('mailboxes'), v.literal('team')));
type Scope = Id<'mailboxes'> | 'team';
type Mark = NonNullable<Doc<'todayStates'>['marks']>[number];

/**
 * `previousSeenAt: 0` on a mark means "there was no mark before this one", so
 * Undo removes the mark instead of setting it to the epoch.
 */
const NO_EARLIER_MARK = 0;

/** The later of the global watermark and this Workbench's own mark. */
function effectiveSeenAt(state: Doc<'todayStates'> | null, scope: Scope | undefined) {
	const mark = scope ? state?.marks?.find((m) => m.key === scope) : undefined;
	const candidates = [state?.seenAt, mark?.seenAt].filter((n): n is number => n !== undefined);
	return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

/** One Workbench's "since you last looked", as the page and the digest use it. */
export interface Watermark {
	seenAt: number;
	previousSeenAt: number | null;
	isFallback: boolean;
}

/**
 * The watermark for one Workbench (or the global one without `scope`). With
 * no watermark yet it is the first-visit fallback: the last 24 hours from the
 * server's `now`. The digest reads it here too, so the client never passes a
 * `since` and both reads agree on the same stored marks.
 */
export function resolveWatermark(
	state: Doc<'todayStates'> | null,
	scope: Scope | undefined,
	now: number
): Watermark {
	const seenAt = effectiveSeenAt(state, scope);
	if (seenAt === undefined) {
		return {
			seenAt: Math.max(0, now - FIRST_VISIT_LOOKBACK_MS),
			previousSeenAt: null,
			isFallback: true,
		};
	}
	const mark = scope ? state?.marks?.find((m) => m.key === scope) : undefined;
	const previous = scope ? mark?.previousSeenAt : state?.previousSeenAt;
	return {
		seenAt,
		previousSeenAt: previous === undefined || previous === NO_EARLIER_MARK ? null : previous,
		isFallback: false,
	};
}

async function assertScopeReadable(ctx: MutationCtx, scope: Scope | undefined) {
	if (scope === undefined || scope === 'team') return;
	const access = await requireMailboxAccess(ctx, scope);
	if (!access.ok) throwForbidden('Mailbox not accessible');
}

export async function loadState(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	organizationId: string
) {
	return ctx.db
		.query('todayStates')
		.withIndex('by_user_and_organization', (q) =>
			q.eq('userId', userId).eq('organizationId', organizationId)
		)
		.unique();
}

/**
 * The caller's watermark, for one Workbench when `scope` is given (the later
 * of that Workbench's mark and the global one). `isFallback` marks the
 * first-visit case, where the page shows the last 24 hours instead of "since
 * you last looked".
 *
 * `watermarks` carries the same answer for every Workbench at once: each tab
 * with a mark of its own, and `unmarked` for any other tab (the global
 * watermark, with nothing to undo). The web reads this query once, without
 * `scope`, and picks the open tab's watermark locally, so the hide list and
 * the watermark share one subscription and a tab switch needs no round trip.
 *
 * The first-visit fallback counts from the server clock. `now` is still
 * accepted for clients from before that change and ignored; drop it after
 * one release.
 */
// all-members: every member reads only their own watermark (keyed by session.userId).
export const get = authedQuery({
	args: { now: v.optional(v.number()), scope: scopeValidator },
	handler: async (ctx, args, session) => {
		const state = await loadState(ctx, session.userId, session.activeOrganizationId);
		const now = Date.now();
		const marks = (state?.marks ?? []).map((m) => ({
			scope: m.key,
			...resolveWatermark(state, m.key, now),
		}));
		return {
			...resolveWatermark(state, args.scope, now),
			hiddenMailboxIds: state?.hiddenMailboxIds ?? [],
			watermarks: {
				unmarked: { ...resolveWatermark(state, undefined, now), previousSeenAt: null },
				marks,
			},
		};
	},
});

/**
 * Move a watermark to `at` (clamped to the server clock, never backwards).
 * Without `scope` it is the global one, which catches every Workbench up
 * (finishing the Answer queue); with one, only that Workbench moves. The old
 * value is kept so the page can offer Undo.
 */
// all-members: a member moves only their own watermark (self-scoped by session.userId).
export const markSeen = authedMutation({
	args: { at: v.optional(v.number()), scope: scopeValidator },
	handler: async (ctx, args, session) => {
		const now = Date.now();
		const at = Math.min(args.at ?? now, now);
		await assertScopeReadable(ctx, args.scope);
		const state = await loadState(ctx, session.userId, session.activeOrganizationId);

		if (args.scope !== undefined) {
			const marks = state?.marks ?? [];
			const mark = marks.find((m) => m.key === args.scope);
			if (mark && at <= mark.seenAt) return { seenAt: mark.seenAt };
			const next: Mark = {
				key: args.scope,
				seenAt: at,
				previousSeenAt: mark?.seenAt ?? NO_EARLIER_MARK,
			};
			const nextMarks = [...marks.filter((m) => m.key !== args.scope), next].slice(-MAX_MARKS);
			if (state) await ctx.db.patch(state._id, { marks: nextMarks, updatedAt: now });
			else {
				await ctx.db.insert('todayStates', {
					userId: session.userId,
					organizationId: session.activeOrganizationId,
					marks: nextMarks,
					updatedAt: now,
				});
			}
			return { seenAt: at };
		}

		if (!state) {
			await ctx.db.insert('todayStates', {
				userId: session.userId,
				organizationId: session.activeOrganizationId,
				seenAt: at,
				updatedAt: now,
			});
			return { seenAt: at };
		}
		if (state.seenAt === undefined) {
			await ctx.db.patch(state._id, { seenAt: at, updatedAt: now });
			return { seenAt: at };
		}
		if (at <= state.seenAt) return { seenAt: state.seenAt };
		await ctx.db.patch(state._id, { seenAt: at, previousSeenAt: state.seenAt, updatedAt: now });
		return { seenAt: at };
	},
});

/** Put a watermark back where it was before its last `markSeen`. */
// all-members: self-scoped by session.userId, like markSeen.
export const undoMarkSeen = authedMutation({
	args: { scope: scopeValidator },
	handler: async (ctx, args, session) => {
		const state = await loadState(ctx, session.userId, session.activeOrganizationId);
		if (!state) return { restored: false };
		if (args.scope !== undefined) {
			const marks = state.marks ?? [];
			const mark = marks.find((m) => m.key === args.scope);
			if (!mark || mark.previousSeenAt === undefined) return { restored: false };
			const others = marks.filter((m) => m.key !== args.scope);
			const restored =
				mark.previousSeenAt === NO_EARLIER_MARK
					? others
					: [...others, { key: mark.key, seenAt: mark.previousSeenAt }];
			await ctx.db.patch(state._id, { marks: restored, updatedAt: Date.now() });
			return { restored: true };
		}
		if (state.previousSeenAt === undefined) return { restored: false };
		await ctx.db.patch(state._id, {
			seenAt: state.previousSeenAt,
			previousSeenAt: undefined,
			updatedAt: Date.now(),
		});
		return { restored: true };
	},
});

/**
 * Show or hide one inbox on the caller's Today. Hiding needs read access to
 * the inbox (so the list only ever holds ids the caller could see); showing
 * never does, so an inbox the caller has since lost access to can still be
 * taken off the list.
 */
// all-members: self-scoped by session.userId; hiding re-checks mailbox access.
export const setMailboxShown = authedMutation({
	args: { mailboxId: v.id('mailboxes'), shown: v.boolean() },
	handler: async (ctx, args, session) => {
		const state = await loadState(ctx, session.userId, session.activeOrganizationId);
		const current = state?.hiddenMailboxIds ?? [];
		const isHidden = current.includes(args.mailboxId);
		// Already in the asked-for state.
		if (args.shown !== isHidden) return { hiddenMailboxIds: current };
		if (!args.shown) {
			const access = await requireMailboxAccess(ctx, args.mailboxId);
			if (!access.ok) throwForbidden('Mailbox not accessible');
		}
		const next = args.shown
			? current.filter((id) => id !== args.mailboxId)
			: [...current, args.mailboxId].slice(-MAX_HIDDEN_MAILBOXES);

		const now = Date.now();
		if (state) {
			await ctx.db.patch(state._id, { hiddenMailboxIds: next, updatedAt: now });
		} else {
			await ctx.db.insert('todayStates', {
				userId: session.userId,
				organizationId: session.activeOrganizationId,
				hiddenMailboxIds: next,
				updatedAt: now,
			});
		}
		return { hiddenMailboxIds: next };
	},
});
