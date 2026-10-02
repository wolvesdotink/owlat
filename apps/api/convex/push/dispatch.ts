/**
 * Web Push decisions: which of a person's devices get a notification for one
 * event, and what it says. The transactional half of the sender — the node
 * action in `push/send.ts` calls in here before and after the network.
 *
 * The rules are the desktop's, from `@owlat/shared/notificationRules`, read
 * against the same `mailUserSettings` row, so web and desktop agree:
 *
 *   - MAIL (a personal inbox): mute, "notify me when they reply", the "Notify
 *     me about" scope and quiet hours, in that order. Quiet hours are local
 *     minutes, so each device is judged on its own reported time zone, and what
 *     they hold back is counted per device and rolled into one summary when the
 *     window closes (`takeQuietSummary`).
 *   - ASSIGNMENT (a shared-inbox thread handed to me, or the agent asking me):
 *     everything but "Nothing", exactly as the desktop notifies them.
 *   - CHAT (an @-mention or a direct message): treated as mail from a person —
 *     a muted room is muted, "Nothing" silences it, quiet hours hold it.
 *
 * Every event is re-read here rather than trusted from the producer: a message
 * read, deleted or moved before the job runs does not notify, and a surface
 * whose feature flag was switched off does not either. So is the person's
 * access: someone removed from the organization since the event gets nothing,
 * and an assignment reaches only a current shared-inbox reader (an assignee
 * demoted meanwhile no longer sees the thread in the app either).
 */

import { v } from 'convex/values';
import {
	decideNotification,
	isQuietAt,
	localClockIn,
	minutesUntilQuietEnd,
	resolveNotifyAbout,
	resolveQuietHours,
	type NotifyAbout,
	type QuietHours,
} from '@owlat/shared/notificationRules';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { components, internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { isFeatureEnabled } from '../lib/featureFlags';
import { isThreadMuted } from '../lib/mailMute';
import {
	getSingletonOrganizationId,
	loadOwnUserProfile,
	type OrganizationRole,
} from '../lib/sessionOrganization';
import { loadProfileSummary } from '../lib/userProfiles';
import { pushEventValidator } from '../lib/validators/push';
import { canUserReadMailbox, loadPersonalMailboxForUser } from '../mail/permissions';
import { getMembership, isMailThreadDiscussion } from '../chat/_helpers';
import { isSharedInboxReader } from '../inbox/access';
import { isWebPushConfigured } from './config';
import {
	assignmentPayload,
	chatPayload,
	mailPayload,
	quietSummaryPayload,
	testPayload,
	type PushPayload,
} from './copy';
import type { Infer } from 'convex/values';

type PushEvent = Infer<typeof pushEventValidator>;

/** Most devices one person is ever pushed to; `subscribe` keeps the table under it. */
export const MAX_DEVICES_PER_USER = 20;

/** How long a push service should hold an undelivered message, per kind. */
const TTL_SECONDS = { mail: 12 * 3600, assignment: 12 * 3600, chat: 3600, quiet: 3600, test: 600 };

/** One push the sender should make. Internal only: it carries the device keys. */
export interface PushDelivery {
	subscriptionId: Id<'pushSubscriptions'>;
	endpoint: string;
	p256dh: string;
	auth: string;
	payload: string;
	topic: string;
	ttlSeconds: number;
}

/** How an event is judged per device, once it has been resolved to copy. */
type Rule =
	| { kind: 'mail-rules'; category?: string; muted: boolean; alerted: boolean }
	| { kind: 'unless-nothing' }
	| { kind: 'always' };

interface Resolved {
	payload: PushPayload;
	rule: Rule;
	ttlSeconds: number;
}

interface Preferences {
	notifyAbout: NotifyAbout;
	quietHours: QuietHours;
	isPrivate: boolean;
	locale: string | undefined;
}

async function loadPreferences(ctx: MutationCtx, userId: string): Promise<Preferences> {
	const row = await ctx.db
		.query('mailUserSettings')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.first();
	const profile = await loadOwnUserProfile(ctx, userId);
	return {
		// Same default as the web reader: people-only once categories exist.
		notifyAbout: resolveNotifyAbout(row?.notifyAbout, await isFeatureEnabled(ctx, 'ai')),
		quietHours: resolveQuietHours(row?.quietHours),
		isPrivate: row?.isHidePreviewOn === true,
		locale: profile?.locale,
	};
}

/** The person's role in this instance's organization now; null once they have left it. */
async function loadCurrentRole(ctx: MutationCtx, userId: string): Promise<OrganizationRole | null> {
	const organizationId = await getSingletonOrganizationId(ctx);
	const member = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: 'member',
		where: [
			{ field: 'organizationId', value: organizationId },
			{ field: 'userId', value: userId },
		],
	})) as { role?: string } | null;
	return (member?.role ?? null) as OrganizationRole | null;
}

async function hasMailFeature(ctx: MutationCtx): Promise<boolean> {
	return (await isFeatureEnabled(ctx, 'postbox')) || (await isFeatureEnabled(ctx, 'mail.external'));
}

async function resolveMail(
	ctx: MutationCtx,
	userId: string,
	messageId: Id<'mailMessages'>,
	prefs: Preferences
): Promise<Resolved | null> {
	const message = await ctx.db.get(messageId);
	if (!message || message.flagSeen) return null;
	const folder = await ctx.db.get(message.folderId);
	if (folder?.role !== 'inbox') return null;
	// Only the owner's own personal mailbox, and only while it is live.
	const mailbox = await loadPersonalMailboxForUser(ctx, message.mailboxId, userId);
	if (mailbox?.status !== 'active' || !(await hasMailFeature(ctx))) return null;
	const thread = await ctx.db.get(message.threadId);
	return {
		payload: mailPayload(
			{
				threadId: message.threadId,
				messageId: message._id,
				mailboxId: message.mailboxId,
				senderName: message.fromName || message.fromAddress,
				subject: message.subject,
				isSealed: message.inboundEncryptionInfo !== undefined,
			},
			prefs.locale,
			prefs.isPrivate
		),
		rule: {
			kind: 'mail-rules',
			category: thread?.category?.label,
			muted: isThreadMuted(thread),
			alerted: thread?.notifyOnReplyAt != null,
		},
		ttlSeconds: TTL_SECONDS.mail,
	};
}

async function resolveAssignment(
	ctx: MutationCtx,
	userId: string,
	noticeId: Id<'inboxAssignmentNotices'>,
	prefs: Preferences,
	role: OrganizationRole
): Promise<Resolved | null> {
	const notice = await ctx.db.get(noticeId);
	if (!notice || notice.userId !== userId) return null;
	// Internal-note mentions are not pushed (nothing enqueues them yet), and
	// assignment copy would word one as a handover.
	if (notice.kind === 'mention') return null;
	// The notice was authorized when it was written; the thread is shown only to
	// whoever reads the shared inbox now, as `inbox.queries.pendingAssignments`.
	if (!isSharedInboxReader({ role })) return null;
	if (!(await isFeatureEnabled(ctx, 'inbox'))) return null;
	return {
		payload: assignmentPayload(
			{
				threadId: notice.threadId,
				kind: notice.kind ?? 'assignment',
				subject: notice.subject,
				assignedByName: notice.assignedByName,
			},
			prefs.locale,
			prefs.isPrivate
		),
		rule: { kind: 'unless-nothing' },
		ttlSeconds: TTL_SECONDS.assignment,
	};
}

async function resolveChat(
	ctx: MutationCtx,
	userId: string,
	messageId: Id<'chatMessages'>,
	prefs: Preferences
): Promise<Resolved | null> {
	const message = await ctx.db.get(messageId);
	if (!message || message.deletedAt || message.authorId === userId) return null;
	if (!(await isFeatureEnabled(ctx, 'chat'))) return null;
	const room = await ctx.db.get(message.roomId);
	if (!room || room.archivedAt) return null;

	let url = `/dashboard/chat/${room._id}`;
	let roomName: string | undefined = room.kind === 'dm' ? undefined : `#${room.name}`;
	let muted = false;
	let isSealedThread = false;
	if (isMailThreadDiscussion(room)) {
		// A team discussion belongs to an email: the click opens that email, and
		// only while this person can still read its mailbox.
		const thread = room.linkedMailThreadId ? await ctx.db.get(room.linkedMailThreadId) : null;
		const mailbox = thread ? await ctx.db.get(thread.mailboxId) : null;
		if (!thread || !mailbox || !thread.latestMessageId) return null;
		if (!(await canUserReadMailbox(ctx, mailbox, userId))) return null;
		url = `/dashboard/postbox/inbox/${thread.latestMessageId}?mailbox=${thread.mailboxId}`;
		// A sealed (E2EE) email's subject was restored from inside the
		// ciphertext: it never goes into a payload, not even as a room name.
		const latest = await ctx.db.get(thread.latestMessageId);
		isSealedThread = latest?.inboundEncryptionInfo !== undefined;
		roomName = isSealedThread ? undefined : thread.latestSubject;
	} else {
		const membership = await getMembership(ctx, room._id, userId);
		if (!membership) return null;
		muted = membership.mutedUntil !== undefined && membership.mutedUntil > Date.now();
	}
	const author = await loadProfileSummary(ctx, message.authorId);
	return {
		payload: chatPayload(
			{
				roomId: room._id,
				authorName: author.name?.trim() || author.email || 'Owlat',
				roomName,
				isSealedThread,
				text: message.text,
				url,
			},
			prefs.locale,
			prefs.isPrivate
		),
		// A mention or a DM is a person talking to you: the people-only scope lets it through.
		rule: { kind: 'mail-rules', category: 'person', muted, alerted: false },
		ttlSeconds: TTL_SECONDS.chat,
	};
}

async function resolveEvent(
	ctx: MutationCtx,
	userId: string,
	event: PushEvent,
	prefs: Preferences,
	role: OrganizationRole
): Promise<Resolved | null> {
	switch (event.kind) {
		case 'mail':
			return resolveMail(ctx, userId, event.messageId, prefs);
		case 'assignment':
			return resolveAssignment(ctx, userId, event.noticeId, prefs, role);
		case 'chat':
			return resolveChat(ctx, userId, event.messageId, prefs);
		case 'test':
			return {
				payload: testPayload(prefs.locale),
				rule: { kind: 'always' },
				ttlSeconds: TTL_SECONDS.test,
			};
	}
}

function toDelivery(
	subscription: Doc<'pushSubscriptions'>,
	payload: PushPayload,
	ttlSeconds: number
): PushDelivery {
	return {
		subscriptionId: subscription._id,
		endpoint: subscription.endpoint,
		p256dh: subscription.p256dh,
		auth: subscription.auth,
		payload: JSON.stringify(payload),
		topic: payload.tag,
		ttlSeconds,
	};
}

/**
 * Count one held-back notification on a device and make sure its summary is
 * scheduled for the moment the window ends there.
 */
async function deferForQuietHours(
	ctx: MutationCtx,
	subscription: Doc<'pushSubscriptions'>,
	quietHours: QuietHours,
	now: number
): Promise<void> {
	const patch: Partial<Doc<'pushSubscriptions'>> = {
		quietDeferredCount: (subscription.quietDeferredCount ?? 0) + 1,
	};
	if (subscription.quietSummaryAt === undefined) {
		const minutes = minutesUntilQuietEnd(quietHours, localClockIn(subscription.timeZone, now));
		const at = now + (minutes ?? 1) * 60_000;
		patch.quietSummaryAt = at;
		await ctx.scheduler.runAt(at, internal.push.send.deliverQuietSummary, {
			subscriptionId: subscription._id,
		});
	}
	await ctx.db.patch(subscription._id, patch);
}

/**
 * Resolve one event for one person into the pushes to make now, deferring what
 * quiet hours hold back. Empty when push is off, the person has no devices, or
 * nothing about the event should interrupt them.
 */
export const prepareDelivery = internalMutation({
	args: { userId: v.string(), event: pushEventValidator },
	handler: async (ctx, { userId, event }): Promise<PushDelivery[]> => {
		if (!isWebPushConfigured()) return [];
		const subscriptions = await ctx.db
			.query('pushSubscriptions')
			.withIndex('by_user', (q) => q.eq('userId', userId))
			.take(MAX_DEVICES_PER_USER);
		const targets =
			event.kind === 'test'
				? subscriptions.filter((subscription) => subscription._id === event.subscriptionId)
				: subscriptions;
		if (targets.length === 0) return [];

		// Every surface behind these events is for current members only.
		const role = await loadCurrentRole(ctx, userId);
		if (!role) return [];

		const prefs = await loadPreferences(ctx, userId);
		const resolved = await resolveEvent(ctx, userId, event, prefs, role);
		if (!resolved) return [];

		const now = Date.now();
		const deliveries: PushDelivery[] = [];
		for (const subscription of targets) {
			const { rule } = resolved;
			if (rule.kind === 'always') {
				deliveries.push(toDelivery(subscription, resolved.payload, resolved.ttlSeconds));
				continue;
			}
			if (rule.kind === 'unless-nothing') {
				if (prefs.notifyAbout !== 'nothing') {
					deliveries.push(toDelivery(subscription, resolved.payload, resolved.ttlSeconds));
				}
				continue;
			}
			const decision = decideNotification({
				category: rule.category,
				setting: prefs.notifyAbout,
				muted: rule.muted,
				alerted: rule.alerted,
				quiet: isQuietAt(prefs.quietHours, localClockIn(subscription.timeZone, now)),
			});
			if (decision.fire) {
				deliveries.push(toDelivery(subscription, resolved.payload, resolved.ttlSeconds));
			} else if (decision.suppressed === 'quiet-hours') {
				await deferForQuietHours(ctx, subscription, prefs.quietHours, now);
			}
		}
		return deliveries;
	},
});

/**
 * The "while you were away" push for one device, once its quiet window has
 * closed. Clears the count in the same transaction, so a retried job cannot
 * send the summary twice. When the window has moved (the person changed it
 * meanwhile) the summary is rescheduled for the new end instead.
 */
export const takeQuietSummary = internalMutation({
	args: { subscriptionId: v.id('pushSubscriptions') },
	handler: async (ctx, { subscriptionId }): Promise<PushDelivery | null> => {
		const subscription = await ctx.db.get(subscriptionId);
		if (!subscription) return null;
		const count = subscription.quietDeferredCount ?? 0;
		if (
			count === 0 ||
			!isWebPushConfigured() ||
			!(await loadCurrentRole(ctx, subscription.userId))
		) {
			await ctx.db.patch(subscriptionId, {
				quietDeferredCount: undefined,
				quietSummaryAt: undefined,
			});
			return null;
		}
		const prefs = await loadPreferences(ctx, subscription.userId);
		const now = Date.now();
		const minutes = minutesUntilQuietEnd(
			prefs.quietHours,
			localClockIn(subscription.timeZone, now)
		);
		if (minutes !== null) {
			const at = now + minutes * 60_000;
			await ctx.db.patch(subscriptionId, { quietSummaryAt: at });
			await ctx.scheduler.runAt(at, internal.push.send.deliverQuietSummary, { subscriptionId });
			return null;
		}
		await ctx.db.patch(subscriptionId, {
			quietDeferredCount: undefined,
			quietSummaryAt: undefined,
		});
		if (prefs.notifyAbout === 'nothing') return null;
		return toDelivery(subscription, quietSummaryPayload(count, prefs.locale), TTL_SECONDS.quiet);
	},
});

/**
 * Write back what the push services said: stamp `lastSuccessAt` on accepted
 * devices and delete the ones that answered 404/410 — the browser dropped that
 * subscription, and it will never accept a message again.
 */
export const recordOutcomes = internalMutation({
	args: {
		outcomes: v.array(
			v.object({
				subscriptionId: v.id('pushSubscriptions'),
				outcome: v.union(
					v.literal('delivered'),
					v.literal('gone'),
					v.literal('rejected'),
					v.literal('failed')
				),
			})
		),
	},
	handler: async (ctx, { outcomes }) => {
		const now = Date.now();
		for (const { subscriptionId, outcome } of outcomes) {
			const subscription = await ctx.db.get(subscriptionId);
			if (!subscription) continue;
			if (outcome === 'gone') await ctx.db.delete(subscriptionId);
			else if (outcome === 'delivered') await ctx.db.patch(subscriptionId, { lastSuccessAt: now });
		}
	},
});
