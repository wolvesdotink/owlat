import { internalMutation, type MutationCtx, type QueryCtx } from '../_generated/server';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { isDeliveryConfigured } from '../lib/sendProviders/capability';
import { mailboxHasSendTransport } from '../mail/draftQueries';
import { getActiveMailboxForUser } from '../mail/mailbox';
import { getMailSyncConfig, getMtaConfig } from '../mail/mtaClient';

/**
 * "You can send now" — the unblock signal for the waiting member.
 *
 * A member who lands in onboarding while the instance has no outbound transport
 * is told the truth ("your admin is still setting up sending") and their
 * first-send step stays open, because a test send would be silently dropped.
 * Nothing used to tell them when that changed: the step sat open forever unless
 * they happened to come back and try again.
 *
 * This module closes that loop. {@link syncSendPathReadiness} samples "does this
 * deployment have any outbound path?" on a cron and, on the no-transport →
 * transport EDGE, writes one `sendReadyNotices` row per member whose first-send
 * step is still open AND whose own mail would now actually leave (the same
 * per-mailbox resolution the send path gates `firstSendDone` on — the trigger is
 * instance-wide, the promise is personal). The member's own session reads it
 * back through {@link getState} and raises a single in-app toast deep-linking to
 * the step, then {@link acknowledge}s it — so the nudge survives a reload and
 * fires exactly once, which matters because the member is usually offline at the
 * moment the admin finishes the setup.
 *
 * A cron rather than a hook on the transport mutations, because readiness is
 * also (and on self-host, mostly) driven by environment configuration —
 * `EMAIL_PROVIDER` plus its credentials — which no mutation observes. Sampling
 * the derived answer catches every path to "we can send now" with one trigger.
 *
 * The readiness/edge decision is kept as pure functions so the trigger is
 * unit-testable without a datastore.
 */

/** How a fresh readiness sample relates to the previously recorded one. */
export type ReadinessEdge = 'baseline' | 'unchanged' | 'became_ready' | 'became_unready';

/**
 * Classify a readiness sample against the last recorded one. `previous === null`
 * (no row yet) is a BASELINE, never an edge: an instance whose very first sample
 * is "ready" never blocked anyone, so nobody is owed a notification.
 */
export function classifyReadinessEdge(previous: boolean | null, current: boolean): ReadinessEdge {
	if (previous === null) return 'baseline';
	if (previous === current) return 'unchanged';
	return current ? 'became_ready' : 'became_unready';
}

/** One member's onboarding state, as the fan-out decision sees it. */
export interface WaitingMember {
	authUserId: string;
	/** Completion stamp of the personal first-send step; null ⇒ still open. */
	firstSendDone: number | null;
	/** The member hid their own checklist; null ⇒ still showing. */
	dismissedAt: number | null;
	/** An earlier notice of theirs is still unacknowledged. */
	hasPendingNotice: boolean;
	/** Their own mail would actually leave the instance now. */
	canSendNow: boolean;
}

/**
 * Which members are owed a "you can send now" notice. Deliberately narrow:
 *
 * - a member whose own mail still cannot leave (no transport behind THEIR
 *   mailbox) would be told a lie — the instance-wide edge is the trigger, but
 *   the member's own send path is the promise;
 * - a member who already sent (`firstSendDone`) was never blocked;
 * - a member who dismissed their checklist opted out of onboarding nudges;
 * - a member with a notice still pending gets one nudge, not a stack (a
 *   transport that flaps ready → unready → ready must not toast twice).
 */
export function selectWaitingMembers(members: readonly WaitingMember[]): string[] {
	return members
		.filter(
			(m) =>
				m.canSendNow && m.firstSendDone === null && m.dismissedAt === null && !m.hasPendingNotice
		)
		.map((m) => m.authUserId);
}

/**
 * Does the instance have ANY outbound path? The campaign/transactional delivery
 * provider (`isDeliveryConfigured`, the checklist's `sendPathReady`) OR the
 * personal-mail transports Postbox sends through (the MTA for hosted mailboxes,
 * the mail-sync worker for connected external accounts). Either arriving is a
 * reason to re-examine who is unblocked; per-member truth is
 * {@link memberCanSend}.
 */
async function instanceCanSend(ctx: QueryCtx | MutationCtx): Promise<boolean> {
	if (getMtaConfig() !== null || getMailSyncConfig() !== null) return true;
	return await isDeliveryConfigured(ctx);
}

/**
 * Would THIS member's mail actually leave the instance? Resolved exactly like
 * the fresh-start "email myself" gate and the send-time `firstSendDone` stamp
 * (`mail/draftQueries.mailboxHasSendTransport`), so the notice, the checklist
 * step and the button never disagree.
 *
 * A member with no mailbox yet falls back to the instance answer: their blocker
 * is the missing mailbox — its own checklist step — not sending.
 */
async function memberCanSend(
	ctx: QueryCtx | MutationCtx,
	authUserId: string,
	fallback: boolean
): Promise<boolean> {
	const mailbox = await getActiveMailboxForUser(ctx, authUserId);
	if (!mailbox) return fallback;
	return await mailboxHasSendTransport(ctx, mailbox);
}

/** The caller's pending (unacknowledged) notices, newest first. */
async function pendingNoticesFor(ctx: QueryCtx | MutationCtx, userId: string) {
	const rows = await ctx.db
		.query('sendReadyNotices')
		.withIndex('by_user_and_created', (q) => q.eq('userId', userId))
		.order('desc')
		.take(10);
	return rows.filter((row) => row.acknowledgedAt === undefined);
}

/** Insert one notice per member the readiness edge just unblocked. */
async function notifyWaitingMembers(ctx: MutationCtx, now: number): Promise<number> {
	const rows = await ctx.db.query('userOnboarding').collect(); // bounded: one row per member of the single deployment org

	const members: WaitingMember[] = [];
	for (const row of rows) {
		const pending = await pendingNoticesFor(ctx, row.authUserId);
		members.push({
			authUserId: row.authUserId,
			firstSendDone: row.firstSendDone ?? null,
			dismissedAt: row.dismissedAt ?? null,
			hasPendingNotice: pending.length > 0,
			// No mailbox ⇒ no notice: "finish your test send" would be a lie to
			// someone who has nothing to send from. They see the live state in the
			// welcome flow once their mailbox exists.
			canSendNow: await memberCanSend(ctx, row.authUserId, false),
		});
	}

	const recipients = selectWaitingMembers(members);
	for (const userId of recipients) {
		await ctx.db.insert('sendReadyNotices', { userId, createdAt: now });
	}
	return recipients.length;
}

/**
 * Sample instance send readiness and, on the false → true edge, notify every
 * member still waiting on their first send. Idempotent per edge: the recorded
 * row is what makes a level a transition, so re-running on an unchanged sample
 * writes nothing.
 */
export const syncSendPathReadiness = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ edge: ReadinessEdge; notified: number }> => {
		const isReady = await instanceCanSend(ctx);
		const state = await ctx.db.query('sendPathReadiness').first();
		const edge = classifyReadinessEdge(state ? state.isReady : null, isReady);
		const now = Date.now();

		if (!state) {
			await ctx.db.insert('sendPathReadiness', { isReady, changedAt: now });
		} else if (edge !== 'unchanged') {
			await ctx.db.patch(state._id, { isReady, changedAt: now });
		}

		if (edge !== 'became_ready') return { edge, notified: 0 };
		return { edge, notified: await notifyWaitingMembers(ctx, now) };
	},
});

/**
 * The member-safe view: can the CALLER send, and do they have a pending unblock
 * notice? One subscription drives both the onboarding checklist's
 * blocked/unblocked send steps and the in-app toast.
 *
 * `isReady` is a single capability boolean — no provider, credential or route
 * detail — which every member already learns implicitly from the honest
 * "your admin is still setting up sending" state.
 */
// all-members: the readiness boolean is a capability every member already sees
// in onboarding, and notices are filtered to the caller's own userId.
export const getState = authedQuery({
	args: {},
	handler: async (
		ctx,
		_args,
		session
	): Promise<{ isReady: boolean; notices: { id: string; createdAt: number }[] }> => {
		const [isReady, pending] = await Promise.all([
			instanceCanSend(ctx).then((instanceReady) =>
				memberCanSend(ctx, session.userId, instanceReady)
			),
			pendingNoticesFor(ctx, session.userId),
		]);
		return {
			isReady,
			notices: pending.map((row) => ({ id: row._id, createdAt: row.createdAt })),
		};
	},
});

/**
 * Mark the caller's pending notices as surfaced, so the toast is a once-ever
 * event rather than one per page load.
 */
// authz: self — only rows keyed to session.userId are patched.
export const acknowledge = authedMutation({
	args: {},
	handler: async (ctx, _args, session) => {
		const now = Date.now();
		for (const row of await pendingNoticesFor(ctx, session.userId)) {
			await ctx.db.patch(row._id, { acknowledgedAt: now });
		}
	},
});
