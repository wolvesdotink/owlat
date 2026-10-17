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

import { internalAction, type ActionCtx } from '../_generated/server';
import type { FunctionReturnType } from 'convex/server';
import { internal } from '../_generated/api';
import type { EditorBlock } from '@owlat/shared';
import { escapeHtml } from '@owlat/shared/html';
import { renderEmailHtml, renderPlainText } from '@owlat/email-renderer';
import { buildMessageId, buildRfc822, type DraftRow } from './rfc822';
import { getOptional } from '../lib/env';
import { logError } from '../lib/runtimeLog';
import {
	DIGEST_WAIT_MS,
	MAX_EMAIL_ITEMS,
	type BriefEmailItem,
	type BriefEmailPayloadSenders,
} from './briefEmail';
import { dailyBriefEmailCopy, systemEmailLocale } from '../lib/systemEmailCopy';
import { prepareDigest, type PreparedDigest } from './digest/generate';
import { renderedMessageIds, type DigestEmail } from './digest/view';
import { digestBlocks } from './digest/emailBlocks';
import { anchorActionDeadline } from '../lib/llm/actionDeadline';

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
function briefEmailBlocks(input: {
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

/** The subject: the item count, or the Senders line or digest when that is all the brief carries. */
export function briefEmailSubject(
	copy: ReturnType<typeof dailyBriefEmailCopy>,
	itemCount: number,
	hasSenders: boolean,
	hasDigest = false
): string {
	if (itemCount > 0) return copy.subject(itemCount);
	if (hasSenders) return copy.sendersSubject;
	return hasDigest ? copy.digestSubject : copy.subject(itemCount);
}

/** The weekly Senders line (mail/senders/brief.ts): a small heading, its lines, one link. */
export function sendersBlocks(input: {
	senders: NonNullable<BriefEmailPayloadSenders>;
	copy: ReturnType<typeof dailyBriefEmailCopy>;
	baseUrl: string;
}): EditorBlock[] {
	const { senders, copy } = input;
	const lines = [
		...(senders.rarelyRead > 0 ? [copy.rarelyReadLine(senders.rarelyRead)] : []),
		...senders.openedInUpdates.map((sender) =>
			copy.openedInUpdatesLine(sender.displayName ?? sender.address)
		),
	];
	const href = `${input.baseUrl}/dashboard/postbox/senders?tab=review`;
	const html = [
		`<strong>${escapeHtml(copy.sendersHeading)}</strong>`,
		...lines.map((line) => escapeHtml(line)),
		`<a href="${escapeHtml(href)}">${escapeHtml(copy.sendersLink)}</a>`,
	].join('<br>');
	return [
		{
			id: 'senders',
			type: 'text',
			content: {
				html: `<p style="margin:16px 0 0">${html}</p>`,
				blockType: 'paragraph',
				fontSize: 13,
				textColor: '#444',
			},
		},
	];
}

type DueBrief = FunctionReturnType<typeof internal.mail.briefEmail.listDue>[number];
type DigestRef = Extract<PreparedDigest, { kind: 'ready' }>;

/** Renders of one brief before it goes without a digest whose lines keep changing. */
const MAX_DIGEST_RENDERS = 2;

/** Render one brief (with its digest lines, when given), store it and deliver it. */
async function renderAndDeliver(
	ctx: ActionCtx,
	entry: DueBrief,
	baseUrl: string,
	digest: { ref: DigestRef; email: DigestEmail } | null
): Promise<{ delivered: boolean; isDigestStale?: boolean }> {
	// In the recipient's own language, from `userProfiles.locale` — absent means
	// English, exactly what every account had before the picker existed.
	const copy = dailyBriefEmailCopy(systemEmailLocale(entry.locale));
	const subject = briefEmailSubject(copy, entry.items.length, Boolean(entry.senders), !!digest);
	const blocks = briefEmailBlocks({
		items: entry.items,
		bundledCounts: entry.bundledCounts,
		heading: copy.heading,
		bundledLine: copy.bundledLine,
		emptyLine: copy.emptyLine,
		baseUrl,
	});
	if (digest) blocks.push(...digestBlocks({ digest: digest.email, copy, baseUrl }));
	if (entry.senders) blocks.push(...sendersBlocks({ senders: entry.senders, copy, baseUrl }));
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
		...(digest
			? {
					digest: {
						digestId: digest.ref.digestId,
						claimToken: digest.ref.claimToken,
						renderedMessageIds: renderedMessageIds(digest.email),
					},
				}
			: {}),
	});
	if (!result.delivered) await ctx.storage.delete(rawStorageId);
	return result;
}

/**
 * One due brief (§6.5 for the digest): claim and generate the digest, then
 * render and deliver. A digest another tick is still generating defers the
 * whole brief to the next tick, without the delivery stamp, for at most
 * `DIGEST_WAIT_MS`; then it goes without the digest. A digest whose lines
 * changed between render and delivery (a purge, a fence) is rendered again.
 */
async function deliverOne(ctx: ActionCtx, entry: DueBrief, baseUrl: string): Promise<boolean> {
	const now = Date.now();
	const prepared: PreparedDigest = entry.digestPeriodKey
		? await prepareDigest(ctx, {
				mailboxId: entry.mailboxId,
				periodKey: entry.digestPeriodKey,
				ownerUserId: entry.userId,
			})
		: { kind: 'none' };
	if (prepared.kind === 'busy' && now - (entry.deferredSince ?? now) < DIGEST_WAIT_MS) {
		await ctx.runMutation(internal.mail.briefEmail.deferBriefEmail, { userId: entry.userId, now });
		return false;
	}
	const ref = prepared.kind === 'ready' ? prepared : null;
	for (let render = 0; render <= MAX_DIGEST_RENDERS; render += 1) {
		// The last render goes without the digest: its threads stay pending.
		const email =
			ref && render < MAX_DIGEST_RENDERS
				? await ctx.runQuery(internal.mail.digest.view.digestForEmail, {
						digestId: ref.digestId,
						claimToken: ref.claimToken,
					})
				: null;
		const digest = ref && email && email.groups.length > 0 ? { ref, email } : null;
		if (entry.items.length === 0 && !entry.senders && !digest) return false;
		const result = await renderAndDeliver(ctx, entry, baseUrl, digest);
		if (result.delivered) return true;
		if (!result.isDigestStale) return false;
	}
	return false;
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
		// The digest lines are one model call per due mailbox (§6.5).
		anchorActionDeadline(ctx);
		const due = await ctx.runQuery(internal.mail.briefEmail.listDue, {});
		if (due.length === 0) return { delivered: 0 };

		const baseUrl = (getOptional('SITE_URL') ?? '').replace(/\/+$/, '');
		let delivered = 0;
		for (const entry of due) {
			try {
				if (await deliverOne(ctx, entry, baseUrl)) delivered += 1;
			} catch (err) {
				logError('[Daily Brief] email delivery failed', err);
			}
		}
		return { delivered };
	},
});
