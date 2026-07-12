/**
 * Seed step: demo threads for the seeded shared (team) inboxes.
 *
 * Runs as an internalAction — NOT a `Loader` in the mutation-based pipeline —
 * because `mailMessages.rawStorageId` must reference a real `_storage` blob
 * and `ctx.storage.store` is action-only. `seedDemoHttp` invokes this right
 * after `runSeedDemo` (so the mailboxes it targets exist).
 *
 * Delivery goes through `internal.mail.delivery.deliverToMailbox` — the exact
 * hosted-inbound path — so threading, folder/thread unread counters, spam
 * scoring, and the audit log behave like real mail (the unread counts are what
 * light up the team badges in the Postbox switcher).
 *
 * Idempotency: each fixture message carries a stable Message-ID; a message
 * already delivered is skipped BEFORE storing its blob (`messageSeeded`), so
 * re-running the seed never orphans storage. `deliverToMailbox` dedupes on the
 * same key as a second line of defense. Like `accounts`/`mailboxes`, these are
 * ordinary tenant rows: not swept by `?reset=true`, wiped by `POST /dev/reset`.
 */

import { v } from 'convex/values';
import { internalAction, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import messagesFixture from './fixtures/mailboxMessages.json';

interface MessageFixture {
	/** Stable RFC 5322 Message-ID (without angle brackets) — the dedupe key. */
	messageId: string;
	/** Team-inbox address the message is delivered to. */
	recipient: string;
	/** RFC 5322 From header ("Name <addr>"). */
	from: string;
	subject: string;
	text: string;
	/** Age at seed time; keeps threads ordered and inside the 24h thread window. */
	minutesAgo: number;
	/** Message-ID of an earlier fixture entry — threads this one onto it. */
	inReplyTo?: string;
}

/** Whether a fixture message was already delivered (dedupe before blob store). */
export const messageSeeded = internalQuery({
	args: { rfc822MessageId: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('mailMessages')
			.withIndex('by_rfc822_message_id', (q) => q.eq('rfc822MessageId', args.rfc822MessageId))
			.first();
		return existing !== null;
	},
});

/** Minimal RFC 822 source for the stored raw blob (what "View original" shows). */
function buildRawEml(rec: MessageFixture, receivedAt: number): string {
	return [
		`From: ${rec.from}`,
		`To: ${rec.recipient}`,
		`Subject: ${rec.subject}`,
		`Message-ID: <${rec.messageId}>`,
		...(rec.inReplyTo ? [`In-Reply-To: <${rec.inReplyTo}>`] : []),
		`Date: ${new Date(receivedAt).toUTCString()}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'',
		rec.text,
	].join('\r\n');
}

export const seedMailboxMessages = internalAction({
	args: {},
	handler: async (ctx): Promise<{ inserted: number; skipped: number }> => {
		const records = messagesFixture as MessageFixture[];
		let inserted = 0;
		let skipped = 0;
		const now = Date.now();

		// Sequential on purpose: a reply fixture must find its parent already
		// delivered for `In-Reply-To` threading to land it in the same thread.
		for (const rec of records) {
			const seeded: boolean = await ctx.runQuery(internal.seedDemo.messages.messageSeeded, {
				rfc822MessageId: rec.messageId,
			});
			if (seeded) {
				skipped++;
				continue;
			}

			const receivedAt = now - rec.minutesAgo * 60_000;
			const raw = buildRawEml(rec, receivedAt);
			const blob = new Blob([raw], { type: 'message/rfc822' });
			const rawStorageId = await ctx.storage.store(blob);

			const result: { messageId: unknown } | { skipped: true } = await ctx.runMutation(
				internal.mail.delivery.deliverToMailbox,
				{
					rawStorageId,
					rawSize: blob.size,
					recipientAddress: rec.recipient,
					from: rec.from,
					to: [rec.recipient],
					cc: [],
					bcc: [],
					subject: rec.subject,
					textBodyInline: rec.text,
					messageId: rec.messageId,
					inReplyTo: rec.inReplyTo,
					receivedAt,
					attachments: [],
				}
			);
			// `skipped` here means the target mailbox is missing (partial bootstrap)
			// or a concurrent duplicate — either way the blob row is the only residue
			// and /dev/reset clears storage with everything else.
			if ('skipped' in result) skipped++;
			else inserted++;
		}

		return { inserted, skipped };
	},
});
