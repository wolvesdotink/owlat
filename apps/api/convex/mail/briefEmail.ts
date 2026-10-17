/**
 * Deliver the Daily Brief as an email (idea 29).
 *
 * `mailDailyBriefs` has said "an email delivery of the brief is a separate
 * opt-in" since the digest was built, and a brief you only see after opening the
 * app cannot do a brief's job. This module is that opt-in: at the local time the
 * user picked, the newest persisted brief is rendered and delivered INTO THEIR
 * OWN MAILBOX, with a deep link per item.
 *
 * Nothing here builds a brief. The cron in `mail/dailyBrief.ts` already does
 * that and persists it; this only reads the newest snapshot, so the mail and the
 * Today view can never disagree about what the brief said.
 *
 * ── DELIVERY, NOT SENDING ───────────────────────────────────────────────────
 * The message is inserted through the same `insertDeliveredMessage` the inbound
 * pipeline uses, not pushed out through the MTA and back in. Mail to yourself
 * has no reason to leave the building, and the round trip would have made the
 * digest depend on outbound deliverability to reach its own author.
 *
 * ── THE ANTI-LOOP GUARD ─────────────────────────────────────────────────────
 * A delivered brief is ordinary inbox mail from a known correspondent (you), and
 * without a guard it becomes an item in tomorrow's brief — which is then mailed,
 * and becomes an item in the day after's, compounding forever. Two things stop
 * it, and the first is the one that matters:
 *
 *   1. its thread is marked `isSelfDeliveredBrief`, and `mail/dailyBrief.ts`
 *      skips such threads outright. A POSITIVE marker rather than the absence of
 *      a classification, so the guard does not quietly stop working the day some
 *      other code path starts classifying delivered mail.
 *   2. delivering here bypasses `mail/delivery.ts`, so neither the Reply-Queue
 *      classifier nor the category classifier is ever enqueued for it — which
 *      also means no post-delivery hook fires, so the brief cannot trigger a
 *      vacation auto-reply or a forwarding rule on its way in.
 */

import { v } from 'convex/values';
import { internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import type { Doc, Id } from '../_generated/dataModel';
import { mailMessageAttachmentValidator } from '../lib/validators/mailContent';
import { insertDeliveredMessage } from './deliveryPipeline/insert';
import { batchGet } from '../_utils/batchLoader';
import { getActiveMailboxForUser } from './mailbox/identity';
import { isFencedThread } from './interpret/staleFence';
import { hasDigestPending } from './digest/select';
import { checkDigestDelivery, consumeSentDigest } from './digest/view';

/**
 * How often the delivery cron runs. A brief is due when the user's local
 * time-of-day has entered this window since the last tick — anything narrower
 * would let a delayed tick skip a day entirely.
 */
export const DELIVERY_WINDOW_MINUTES = 15;

/** Items one brief email lists. Past this it stops being a brief. */
export const MAX_EMAIL_ITEMS = 12;

/** Users considered per cron tick — one `mailUserSettings` row per person. */
const MAX_BRIEF_EMAIL_USERS = 500;

/** Minutes past local midnight for an instant, given the user's stored offset. */
export function localMinuteOfDay(nowMs: number, utcOffsetMinutes: number): number {
	const local = nowMs + utcOffsetMinutes * 60_000;
	const minutes = Math.floor(local / 60_000) % 1440;
	return minutes < 0 ? minutes + 1440 : minutes;
}

/** The user's local calendar day (days since epoch) for an instant. */
export function localDayIndex(nowMs: number, utcOffsetMinutes: number): number {
	return Math.floor((nowMs + utcOffsetMinutes * 60_000) / 86_400_000);
}

/**
 * How long a brief waits for a digest another tick is still generating
 * (§6.5): two more ticks. Past it the brief goes without the digest, whose
 * threads stay pending for the next one.
 */
export const DIGEST_WAIT_MS = 2 * DELIVERY_WINDOW_MINUTES * 60_000;

/**
 * Is a brief that waited for its digest due again? It is until it is
 * delivered, for at most {@link DIGEST_WAIT_MS} plus one tick, and only while
 * the person still wants the brief. Pure.
 */
export function isDeferredBriefDue(
	row: {
		dailyBriefEmail?: { enabled: boolean };
		dailyBriefDeferredAt?: number;
		lastDailyBriefEmailAt?: number;
	},
	nowMs: number
): boolean {
	const deferredAt = row.dailyBriefDeferredAt;
	if (deferredAt === undefined || !row.dailyBriefEmail?.enabled) return false;
	if ((row.lastDailyBriefEmailAt ?? 0) >= deferredAt) return false;
	return nowMs - deferredAt <= DIGEST_WAIT_MS + DELIVERY_WINDOW_MINUTES * 60_000;
}

/** The digest period of a brief: the user's local day (§6.5, one digest per day). */
export function digestPeriodKey(nowMs: number, utcOffsetMinutes: number): string {
	return `day:${localDayIndex(nowMs, utcOffsetMinutes)}`;
}

/**
 * Is a brief due for this user right now?
 *
 * Pure, and the two halves are separate on purpose: the TIME check says the
 * user's local clock has just passed the minute they chose, and the DAY check
 * says nothing has been delivered yet on this local day. The day check is what
 * makes the whole thing idempotent — the cron can tick twice inside one window,
 * or be retried after a failure, without mailing two briefs.
 */
export function isBriefDue(
	pref: { enabled: boolean; minute: number; utcOffsetMinutes: number } | undefined,
	lastDeliveredAt: number | undefined,
	nowMs: number
): boolean {
	if (!pref?.enabled) return false;
	const minuteNow = localMinuteOfDay(nowMs, pref.utcOffsetMinutes);
	// The window is closed at the start and open at the end, so two adjacent
	// windows can never both claim the same minute.
	const sinceDue = minuteNow - pref.minute;
	// A window straddling local midnight wraps; adding a day makes the
	// comparison work without a second branch.
	const elapsed = sinceDue < 0 ? sinceDue + 1440 : sinceDue;
	if (elapsed >= DELIVERY_WINDOW_MINUTES) return false;
	if (lastDeliveredAt === undefined) return true;
	return (
		localDayIndex(lastDeliveredAt, pref.utcOffsetMinutes) <
		localDayIndex(nowMs, pref.utcOffsetMinutes)
	);
}

/** One line of the brief email. */
export interface BriefEmailItem {
	kind: string;
	title: string;
	subtitle?: string;
	dueAt?: number;
	/** Path (not a full URL) to the message this item points at, when it has one. */
	path?: string;
}

interface BriefEmailPayload {
	mailboxId: Id<'mailboxes'>;
	address: string;
	/** The recipient's interface language (`userProfiles.locale`); absent = English. */
	locale?: string;
	generatedAt: number;
	items: BriefEmailItem[];
	bundledCounts: { newsletter: number; notification: number; receipt: number };
	/** The weekly Senders line, when this brief carries one (mail/senders/brief.ts). */
	senders?: BriefEmailPayloadSenders;
	/** Read on arrival (§6.5): the digest's period, when digest threads are waiting. */
	digestPeriodKey?: string;
	/** When this brief first waited for a busy digest (§6.5). */
	deferredSince?: number;
}

export type BriefEmailPayloadSenders = Doc<'mailDailyBriefs'>['senders'];

// ── The cron's reads ──────────────────────────────────────────────

/**
 * Everyone whose brief is due in this tick, with the payload to render.
 *
 * ONE query rather than a list-then-fetch-per-user, so the action does a single
 * round trip. Bounded by {@link MAX_BRIEF_EMAIL_USERS}: this table holds one row
 * per person who ever changed a Postbox preference, so the take is the honest
 * ceiling on a deployment's user count rather than an arbitrary page.
 */
export const listDue = internalQuery({
	args: { now: v.optional(v.number()) },
	handler: async (ctx, args): Promise<Array<{ userId: string } & BriefEmailPayload>> => {
		const now = args.now ?? Date.now();
		const rows = await ctx.db.query('mailUserSettings').take(MAX_BRIEF_EMAIL_USERS);
		const due: Array<{ userId: string } & BriefEmailPayload> = [];

		for (const row of rows) {
			const isDeferred = isDeferredBriefDue(row, now);
			if (!isDeferred && !isBriefDue(row.dailyBriefEmail, row.lastDailyBriefEmailAt, now)) {
				continue;
			}
			// The brief is per MAILBOX; the preference is per person. Deliver to the
			// person's own active mailbox — a member with none simply gets nothing.
			// A team inbox they own is not theirs to be briefed on privately.
			const mailbox = await getActiveMailboxForUser(ctx, row.userId);
			if (!mailbox) continue;

			const brief = await ctx.db
				.query('mailDailyBriefs')
				.withIndex('by_mailbox_and_generated', (q) => q.eq('mailboxId', mailbox._id))
				.order('desc')
				.first();
			// Read on arrival (§6.5): digest threads waiting are reason enough to
			// send, and so is the weekly Senders line. Otherwise no brief yet (a
			// fresh mailbox before the build cron's first run), or an empty one,
			// sends nothing rather than a mail that looks like a bug.
			const hasDigest = await hasDigestPending(ctx, mailbox._id);
			// A deferred brief is always listed: with nothing left to send, the
			// delivery pass ends its wait (`endBriefDeferral`) rather than leave it.
			const isEmpty = !brief || (brief.items.length === 0 && !brief.senders);
			if (!hasDigest && isEmpty && !isDeferred) continue;

			// The item threads are independent rows — read them in one pass.
			const itemRows = (brief?.items ?? []).slice(0, MAX_EMAIL_ITEMS);
			const threads = await batchGet(
				ctx,
				itemRows.map((item) => item.threadId)
			);
			const items: BriefEmailItem[] = itemRows.map((item) => {
				const thread = threads.get(item.threadId);
				// A snapshot taken before its thread was fenced (interpret/staleFence.ts)
				// carries the model's summary of the ask: left out now.
				const isFenced = item.kind === 'needs_reply' && isFencedThread(thread ?? null);
				return {
					kind: item.kind,
					title: item.title,
					subtitle: isFenced ? undefined : item.subtitle,
					dueAt: item.dueAt,
					// A deep link per item is the whole reason to mail a brief rather
					// than describe one. A thread whose newest message is gone links
					// nowhere rather than to a 404.
					path: thread?.latestMessageId
						? `/dashboard/postbox/inbox/${thread.latestMessageId}`
						: undefined,
				};
			});
			// The digest is composed on a scheduler with no request behind it, so the
			// language has to come from the profile rather than a cookie.
			const profile = await ctx.db
				.query('userProfiles')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', row.userId))
				.first();

			due.push({
				userId: row.userId,
				mailboxId: mailbox._id,
				address: mailbox.address,
				locale: profile?.locale,
				generatedAt: brief?.generatedAt ?? now,
				items,
				bundledCounts: brief?.bundledCounts ?? { newsletter: 0, notification: 0, receipt: 0 },
				...(brief?.senders ? { senders: brief.senders } : {}),
				...(hasDigest
					? { digestPeriodKey: digestPeriodKey(now, row.dailyBriefEmail?.utcOffsetMinutes ?? 0) }
					: {}),
				...(isDeferred ? { deferredSince: row.dailyBriefDeferredAt } : {}),
			});
		}
		return due;
	},
});

// ── The cron's write ──────────────────────────────────────────────

/**
 * File a rendered brief into the owner's own mailbox and stamp the delivery.
 *
 * Both halves are one transaction on purpose: a message delivered without the
 * stamp would be re-delivered on the next tick, and a stamp without the message
 * would silently skip a day.
 */
export const deliverBriefEmail = internalMutation({
	args: {
		userId: v.string(),
		mailboxId: v.id('mailboxes'),
		rawStorageId: v.id('_storage'),
		rawSize: v.number(),
		messageId: v.string(),
		subject: v.string(),
		bodyText: v.string(),
		bodyHtml: v.string(),
		snippet: v.string(),
		attachments: v.optional(v.array(mailMessageAttachmentValidator)),
		/**
		 * Read on arrival (§6.5): the generated digest this mail carries, and the
		 * lines it was rendered with (message ids, in render order).
		 */
		digest: v.optional(
			v.object({
				digestId: v.id('mailDigests'),
				claimToken: v.string(),
				renderedMessageIds: v.array(v.id('mailMessages')),
			})
		),
	},
	handler: async (ctx, args): Promise<{ delivered: boolean; isDigestStale?: boolean }> => {
		const mailbox = await ctx.db.get(args.mailboxId);
		if (!mailbox) return { delivered: false };
		// The digest must still be generated under this claim (a second delivery
		// sees it sent and does nothing), and its lines must still be the rendered
		// ones: a purge, a fence or a scope change since asks for a re-render.
		let digest: Doc<'mailDigests'> | null = null;
		if (args.digest) {
			const checked = await checkDigestDelivery(ctx, mailbox, args.digest);
			if (checked.kind !== 'ok') {
				return checked.kind === 'stale'
					? { delivered: false, isDigestStale: true }
					: { delivered: false };
			}
			digest = checked.digest;
		}
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('role', 'inbox')
			)
			.first();
		if (!folder) return { delivered: false };

		const now = Date.now();
		const messageId = await insertDeliveredMessage(ctx, {
			mailbox,
			folder,
			rawStorageId: args.rawStorageId,
			rawSize: args.rawSize,
			from: mailbox.address,
			to: [mailbox.address],
			cc: [],
			bcc: [],
			subject: args.subject,
			textBodyInline: args.bodyText,
			htmlBodyInline: args.bodyHtml,
			snippet: args.snippet,
			messageId: args.messageId,
			receivedAt: now,
			attachments: args.attachments ?? [],
			// The brief is a to-do list, so it arrives UNREAD; that is the point of
			// mailing it. It is not counted against the mailbox quota, because a
			// digest we generated is our own overhead, not the user's storage.
			countUsedBytes: false,
		});

		await markThreadAsBrief(ctx, messageId);
		// In the same transaction as the mail: sent, stripped, threads consumed.
		if (digest) await consumeSentDigest(ctx, digest, { sentMessageId: messageId, sentAt: now });
		const settings = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', args.userId))
			.first();
		if (settings) {
			await ctx.db.patch(settings._id, {
				lastDailyBriefEmailAt: now,
				dailyBriefDeferredAt: undefined,
				updatedAt: now,
			});
		}
		return { delivered: true };
	},
});

/** Stamp the anti-loop marker on the thread the delivered brief landed in. */
async function markThreadAsBrief(ctx: MutationCtx, messageId: Id<'mailMessages'>): Promise<void> {
	const delivered: Doc<'mailMessages'> | null = await ctx.db.get(messageId);
	if (!delivered) return;
	await ctx.db.patch(delivered.threadId, { isSelfDeliveredBrief: true });
}

/**
 * The brief waits for a digest another tick is still generating (§6.5): no
 * delivery stamp, so the next tick sends it ({@link isDeferredBriefDue}).
 * A wait that continues (`deferredSince`, from `listDue`) keeps its start,
 * which bounds it; a new wait always writes a fresh timestamp, whatever an
 * abandoned earlier one left behind.
 */
export const deferBriefEmail = internalMutation({
	args: { userId: v.string(), now: v.number(), deferredSince: v.optional(v.number()) },
	handler: async (ctx, args): Promise<void> => {
		const settings = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', args.userId))
			.first();
		if (!settings) return;
		const deferredAt = args.deferredSince ?? args.now;
		if (settings.dailyBriefDeferredAt === deferredAt) return;
		await ctx.db.patch(settings._id, { dailyBriefDeferredAt: deferredAt, updatedAt: args.now });
	},
});

/**
 * A deferred brief that this pass neither deferred again nor delivered (its
 * digest is no longer busy and nothing was left to send): the wait is over.
 * Clears only the deferral it was given.
 */
export const endBriefDeferral = internalMutation({
	args: { userId: v.string(), deferredAt: v.number() },
	handler: async (ctx, args): Promise<void> => {
		const settings = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', args.userId))
			.first();
		if (settings?.dailyBriefDeferredAt !== args.deferredAt) return;
		await ctx.db.patch(settings._id, { dailyBriefDeferredAt: undefined, updatedAt: Date.now() });
	},
});

/** Whether a stored deferral is stale: delivered since, or past its bound. Pure. */
export function isStaleBriefDeferral(
	row: { dailyBriefDeferredAt?: number; lastDailyBriefEmailAt?: number },
	nowMs: number
): boolean {
	const deferredAt = row.dailyBriefDeferredAt;
	if (deferredAt === undefined) return false;
	if ((row.lastDailyBriefEmailAt ?? 0) >= deferredAt) return true;
	return nowMs - deferredAt > DIGEST_WAIT_MS + DELIVERY_WINDOW_MINUTES * 60_000;
}

/**
 * Every pass starts here: clear stale deferrals (the same bounded read as
 * {@link listDue}), so an abandoned wait can never linger.
 */
export const sweepBriefDeferrals = internalMutation({
	args: { now: v.number() },
	handler: async (ctx, args): Promise<number> => {
		const rows = await ctx.db.query('mailUserSettings').take(MAX_BRIEF_EMAIL_USERS);
		let cleared = 0;
		for (const row of rows) {
			if (!isStaleBriefDeferral(row, args.now)) continue;
			await ctx.db.patch(row._id, { dailyBriefDeferredAt: undefined });
			cleared += 1;
		}
		return cleared;
	},
});
