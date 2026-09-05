'use node';

/**
 * The Node half of the daily-brief email (idea 29): render and deliver.
 *
 * Separate from `mail/briefEmail.ts` because rendering needs the Node runtime —
 * `@owlat/email-renderer` and the RFC822 composer both live there — while the
 * schedule math, the payload read and the delivery write are ordinary
 * query/mutation code that stays unit-testable without it. Same split as
 * `emailBlocks/rendering.ts`.
 *
 * The body is composed as `EditorBlock`s and rendered by the SAME renderer every
 * other email in the product goes through, so the digest inherits the client
 * compatibility work (Outlook, inlining, plaintext) instead of being one more
 * hand-written HTML string.
 */

import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import type { EditorBlock } from '@owlat/shared';
import { renderEmailHtml, renderPlainText } from '@owlat/email-renderer';
import { buildMessageId, buildRfc822, type DraftRow } from './rfc822';
import { getOptional } from '../lib/env';
import { logError } from '../lib/runtimeLog';
import { MAX_EMAIL_ITEMS, type BriefEmailItem } from './briefEmail';
import { dailyBriefEmailCopy, systemEmailLocale } from '../lib/systemEmailCopy';

/** Snippet length that matches what the delivery pipeline stores elsewhere. */
const SNIPPET_LENGTH = 200;

/**
 * The brief as renderer blocks.
 *
 * Deliberately plain: a heading, one line per item, and a footer naming what was
 * bundled away. Every item that points at a message is a LINK — a brief you have
 * to go and find the mail for is a worse version of opening the app, which is
 * the problem this feature exists to solve.
 */
export function briefEmailBlocks(input: {
	items: BriefEmailItem[];
	bundledCounts: { newsletter: number; notification: number; receipt: number };
	heading: string;
	bundledLine: (total: number) => string;
	emptyLine: string;
	baseUrl: string;
}): EditorBlock[] {
	const blocks: EditorBlock[] = [
		{
			id: 'heading',
			type: 'text',
			content: {
				html: `<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(input.heading)}</h1>`,
				blockType: 'h1',
				fontSize: 20,
				textColor: '#1a1a1a',
			},
		},
	];

	if (input.items.length === 0) {
		blocks.push({
			id: 'empty',
			type: 'text',
			content: {
				html: `<p>${escapeHtml(input.emptyLine)}</p>`,
				blockType: 'paragraph',
				fontSize: 15,
				textColor: '#444',
			},
		});
	}

	input.items.slice(0, MAX_EMAIL_ITEMS).forEach((item, index) => {
		const title = escapeHtml(item.title);
		// A relative path cannot be clicked from a mail client, so the link is
		// absolutized here — and an item with no target renders as plain text
		// rather than a link that goes nowhere.
		const href = item.path ? `${input.baseUrl}${item.path}` : null;
		const titleHtml = href ? `<a href="${escapeHtml(href)}">${title}</a>` : title;
		const subtitle = item.subtitle ? `<br><span>${escapeHtml(item.subtitle)}</span>` : '';
		blocks.push({
			id: `item-${index}`,
			type: 'text',
			content: {
				html: `<p style="margin:0 0 10px">${titleHtml}${subtitle}</p>`,
				blockType: 'paragraph',
				fontSize: 15,
				textColor: '#1a1a1a',
			},
		});
	});

	const bundledTotal =
		input.bundledCounts.newsletter + input.bundledCounts.notification + input.bundledCounts.receipt;
	if (bundledTotal > 0) {
		blocks.push({
			id: 'bundled',
			type: 'text',
			content: {
				html: `<p style="margin:16px 0 0">${escapeHtml(input.bundledLine(bundledTotal))}</p>`,
				blockType: 'paragraph',
				fontSize: 13,
				textColor: '#666',
			},
		});
	}
	return blocks;
}

/**
 * Deliver every brief that is due in this tick.
 *
 * Per-user failures are logged and skipped, never thrown: one unrenderable brief
 * must not stop everyone else's from arriving, and the delivery stamp is written
 * inside the same mutation as the message, so a skipped user is simply retried
 * on the next tick.
 */
export const deliverDueBriefs = internalAction({
	args: {},
	handler: async (ctx): Promise<{ delivered: number }> => {
		const due = await ctx.runQuery(internal.mail.briefEmail.listDue, {});
		if (due.length === 0) return { delivered: 0 };

		const baseUrl = (getOptional('SITE_URL') ?? '').replace(/\/+$/, '');
		let delivered = 0;

		for (const entry of due) {
			try {
				// In the recipient's own language, from `userProfiles.locale` —
				// absent means English, exactly what every account had before the
				// picker existed.
				const copy = dailyBriefEmailCopy(systemEmailLocale(entry.locale));
				const subject = copy.subject(entry.items.length);
				const blocks = briefEmailBlocks({
					items: entry.items,
					bundledCounts: entry.bundledCounts,
					heading: copy.heading,
					bundledLine: copy.bundledLine,
					emptyLine: copy.emptyLine,
					baseUrl,
				});
				const bodyHtml = renderEmailHtml(blocks);
				const bodyText = renderPlainText(blocks);
				const domain = entry.address.split('@')[1] ?? 'localhost';
				const rfc822MessageId = buildMessageId(domain);

				const draft: DraftRow = {
					_id: 'brief' as DraftRow['_id'],
					mailboxId: entry.mailboxId,
					toAddresses: [entry.address],
					ccAddresses: [],
					bccAddresses: [],
					fromAddress: entry.address,
					subject,
					bodyHtml,
					bodyText,
					state: 'pending_send',
					attachments: [],
				};
				const { raw, size } = buildRfc822(draft, [], rfc822MessageId, undefined, undefined);

				const rawStorageId = await ctx.storage.store(new Blob([new Uint8Array(raw)]));
				const result = await ctx.runMutation(internal.mail.briefEmail.deliverBriefEmail, {
					userId: entry.userId,
					mailboxId: entry.mailboxId,
					rawStorageId,
					rawSize: size,
					messageId: rfc822MessageId,
					subject,
					bodyText,
					bodyHtml,
					snippet: bodyText.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH),
				});
				if (result.delivered) delivered += 1;
			} catch (err) {
				logError('[Daily Brief] email delivery failed', err);
			}
		}
		return { delivered };
	},
});
