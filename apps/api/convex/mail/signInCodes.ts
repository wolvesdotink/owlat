/**
 * One-time codes and sign-in links, read out of a message when it arrives so
 * the row and the reader can offer them in one click (copy the code, open the
 * link).
 *
 * Only for mail that is safe to make one click: live inbound mail from someone
 * other than the mailbox owner, outside Spam, Trash, Sent and Drafts, from a
 * sender whose From domain authenticated (DMARC pass, or a passing DKIM
 * signature aligned with the From domain), that is not list or promotional mail
 * (no List-Unsubscribe, no newsletter / promotion category, no coupon wording),
 * and only when the message names exactly one code or one sign-in link. A
 * spoofed "your code is 123456" or a coupon code gets no button.
 *
 * A link has to point at the From domain's own organizational domain and look
 * like a sign-in path; a click-tracking redirect or a second candidate means no
 * link chip.
 *
 * The value is stored on the message for {@link SIGN_IN_CODE_TTL_MS} after the
 * message was received and cleared by a scheduled {@link expireSignInCode}.
 * The chip also hides itself on the client at `expiresAt`, so a late run never
 * shows a stale code.
 *
 * The detection is the code detector's (`interpret/eligibility.ts
 * isCodeOrSignInMail`); the opt-in "archive after a day" rule that reads it is
 * unchanged.
 *
 * {@link latestSignInCode} and {@link messageSignInCode} hand a live code to
 * the surfaces that are not the message itself: the command palette, and the
 * "Copy code" action of a web push or desktop notification.
 */

import { v } from 'convex/values';
import { extractDomainOrNull } from '@owlat/shared';
import { htmlToPlainText } from '@owlat/shared/html';
import { isIdentifierAligned } from '@owlat/shared/spfAlignment';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { openStoredInlineBody } from '../lib/messageBodyStore';
import type { MailSignInCode } from '../lib/validators/mailContent';
import { isCodeOrSignInMail } from './interpret/eligibility';
import { isFromMailboxOwner } from './needsReplyHeuristic';
import { postboxQuery } from './_helpers';
import { loadAccessibleMailboxes, requireMailboxAccess } from './permissions';

/** How long a code stays offered after the message was received. */
export const SIGN_IN_CODE_TTL_MS = 15 * 60 * 1000;

/** How much of the text the extractor reads (codes sit at the top). */
const HEAD_CHARS = 4000;

/** Longest link the chip offers; anything longer is not a sign-in link worth storing. */
const MAX_LINK_CHARS = 2048;

/** Folders whose mail never gets a chip. */
const EXCLUDED_ROLES: ReadonlySet<string> = new Set(['spam', 'junk', 'trash', 'sent', 'drafts']);

/** Categories that mark promotional or list mail. */
const BULK_CATEGORIES: ReadonlySet<string> = new Set(['newsletter', 'promotion', 'spam']);

/** Coupon and discount wording: a code in such a message is not a sign-in code. */
const PROMO_WORDING =
	/\b(?:discount|coupon|promo(?:tion)?(?:al)?|voucher|gutschein\w*|rabatt\w*|\d{1,2}\s?%\s?(?:off|rabatt))\b/i;

/** "Sign-in link" wording, for mail whose only one-click item is a link. */
const SIGN_IN_LINK_WORDING = /\b(?:sign[- ]?in|log[- ]?in|login|magic|anmelde)[- ]?link\b/i;

/**
 * A code after the word that names it: "code is 482913", "PIN: 4821",
 * "Bestätigungscode lautet 482913". The capture is checked again below
 * (uppercase letters and digits only, at least one digit), so "code below" or
 * "code expires" never count.
 */
const CODE_AFTER_KEYWORD =
	/\b(?:code|pin|passcode|otp|bestätigungscode|sicherheitscode|anmeldecode|einmalcode|verifizierungscode)\b(?:\s+(?:is|lautet|ist|est))?\s*[:\-–]?\s*(\d{3}[ -]\d{3}|[A-Za-z0-9]{4,10})\b/gi;

/** "482913 is your Northwind code" (common in subjects). */
const CODE_BEFORE_PHRASE = /\b(\d{4,8}) (?:is your|ist dein|ist ihr|est votre)\b/gi;

/**
 * The same phrasing as a subject, which the code detector does not read as code
 * mail. It counts here only, so the "archive after a day" rule is unchanged.
 */
const CODE_SUBJECT_PHRASE =
	/^\s*\d{4,8} (?:is your|ist dein|ist ihr|est votre) [^\n]{0,60}\b(?:code|pin)\b/i;

/** A code alone on its own line, as most templates put it. */
const CODE_ON_OWN_LINE = /^[ \t]*(\d{6,8}|\d{3}[ -]\d{3})[ \t]*$/gm;

/** URLs in text, and hrefs in HTML. */
const TEXT_URL = /https:\/\/[^\s<>"')\]]+/g;
const HREF_URL = /href\s*=\s*["']?(https:[^"'\s>]+)/gi;

/** Path wording of a sign-in link; a `?token=` on a help page does not count. */
const SIGN_IN_PATH =
	/(?:log-?in|sign-?in|signin|magic|auth|verify|session|otp|passwordless|token)/i;

/** A token that reads as a code: uppercase letters and digits, at least one digit. */
function normalizeCode(raw: string): string | null {
	if (/^\d{3}[ -]\d{3}$/.test(raw)) return raw.replace(/[ -]/, '');
	if (!/^[A-Z0-9]{4,10}$/.test(raw) || !/\d/.test(raw)) return null;
	return raw;
}

function collectCodes(text: string, into: Set<string>): void {
	for (const pattern of [CODE_AFTER_KEYWORD, CODE_BEFORE_PHRASE, CODE_ON_OWN_LINE]) {
		for (const match of text.matchAll(pattern)) {
			const code = normalizeCode(match[1] ?? '');
			if (code) into.add(code);
		}
	}
}

function decodeHrefEntities(url: string): string {
	return url.replace(/&amp;/g, '&');
}

/** The URL's host, or null when it is not a parseable https URL. */
function httpsHostOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' ? parsed.hostname : null;
	} catch {
		return null;
	}
}

function collectLinks(input: { text: string; html?: string }, fromDomain: string): Set<string> {
	const candidates = [
		...[...input.text.matchAll(TEXT_URL)].map((m) => m[0]),
		...[...(input.html ?? '').matchAll(HREF_URL)].map((m) => decodeHrefEntities(m[1] ?? '')),
	];
	const links = new Set<string>();
	for (const raw of candidates) {
		const url = raw.replace(/[.,;:!?]+$/, '');
		if (url.length > MAX_LINK_CHARS) continue;
		const host = httpsHostOf(url);
		if (!host || !isIdentifierAligned(host, fromDomain)) continue;
		const { pathname, search } = new URL(url);
		if (/unsubscribe/i.test(`${pathname}${search}`) || !SIGN_IN_PATH.test(pathname)) continue;
		links.add(url);
	}
	return links;
}

/**
 * The single code or sign-in link a message names, or null. Pure. Promotional
 * wording, two different codes, or two different sign-in links all give null:
 * offering the wrong one in one click is worse than offering none. A code and
 * a link together give the code: many templates add "or click here to sign
 * in" under the code, and both come from the same sender.
 */
export function extractSignInCode(input: {
	subject: string;
	text: string;
	html?: string;
	fromDomain: string;
}): Pick<MailSignInCode, 'kind' | 'value'> | null {
	const text = input.text.slice(0, HEAD_CHARS);
	if (PROMO_WORDING.test(input.subject) || PROMO_WORDING.test(text)) return null;
	const isCodeMail =
		isCodeOrSignInMail({ subject: input.subject, text }) || CODE_SUBJECT_PHRASE.test(input.subject);
	if (isCodeMail) {
		const codes = new Set<string>();
		collectCodes(input.subject, codes);
		collectCodes(text, codes);
		const [code] = codes;
		if (code !== undefined) return codes.size === 1 ? { kind: 'code', value: code } : null;
	}
	if (!isCodeMail && !SIGN_IN_LINK_WORDING.test(input.subject) && !SIGN_IN_LINK_WORDING.test(text))
		return null;
	const links = collectLinks(
		{ text, html: input.html?.slice(0, HEAD_CHARS * 4) },
		input.fromDomain
	);
	const [link] = links;
	return link !== undefined && links.size === 1 ? { kind: 'link', value: link } : null;
}

/**
 * Did the From domain authenticate? DMARC pass, or a passing DKIM signature
 * whose `d=` aligns with the From domain. An ARC rescue does not count here:
 * the button vouches for the From domain itself. Pure.
 */
export function isSignInSenderAuthenticated(
	message: Pick<Doc<'mailMessages'>, 'dmarcResult' | 'dkimResult' | 'dkimSigningDomain'>,
	fromDomain: string
): boolean {
	if (message.dmarcResult?.trim().toLowerCase() === 'pass') return true;
	return (
		message.dkimResult?.trim().toLowerCase() === 'pass' &&
		message.dkimSigningDomain !== undefined &&
		isIdentifierAligned(message.dkimSigningDomain, fromDomain)
	);
}

/**
 * Read the code or link of a just-delivered message and store it. Called from
 * `deliveryPipeline/afterInsert.ts` for every inbound insert, which schedules
 * {@link expireSignInCode} at the returned expiry. Writes nothing and returns
 * null when any rule in the module doc says no.
 */
export async function recordSignInCode(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	opts: { isLive: boolean; now: number }
): Promise<number | null> {
	if (!opts.isLive || message.spamVerdict === 'spam' || message.unsubscribe) return null;
	const expiresAt = message.receivedAt + SIGN_IN_CODE_TTL_MS;
	if (expiresAt <= opts.now) return null;
	const fromDomain = extractDomainOrNull(message.fromAddress)?.toLowerCase();
	if (!fromDomain || !isSignInSenderAuthenticated(message, fromDomain)) return null;
	const [mailbox, folder, thread] = await Promise.all([
		ctx.db.get(message.mailboxId),
		ctx.db.get(message.folderId),
		ctx.db.get(message.threadId),
	]);
	if (!mailbox || isFromMailboxOwner(message, mailbox.address)) return null;
	if (folder?.role !== undefined && EXCLUDED_ROLES.has(folder.role)) return null;
	if (thread?.category && BULK_CATEGORIES.has(thread.category.label)) return null;

	const body = await openStoredInlineBody(ctx.db, message);
	const text = body.text ?? (body.html ? htmlToPlainText(body.html) : message.snippet);
	const found = extractSignInCode({
		subject: message.subject,
		text,
		...(body.html ? { html: body.html } : {}),
		fromDomain,
	});
	if (!found) return null;
	await ctx.db.patch(message._id, {
		signInCode: { ...found, senderDomain: fromDomain, expiresAt },
	});
	return expiresAt;
}

/** Drop a message's stored code once it expired (scheduled by {@link recordSignInCode}). */
export const expireSignInCode = internalMutation({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.messageId);
		if (!message?.signInCode || message.signInCode.expiresAt > Date.now()) return;
		await ctx.db.patch(message._id, { signInCode: undefined });
	},
});

/** A live code or link, with the message it came from. */
export interface LiveSignInCode extends MailSignInCode {
	messageId: Id<'mailMessages'>;
	mailboxId: Id<'mailboxes'>;
}

/**
 * Newest messages per mailbox the palette looks through. A code lives for 15
 * minutes, so the window only has to cover one mailbox's arrivals in that time.
 */
const RECENT_SCAN = 25;

/**
 * The message's code, while it is live and the message has not since gone to
 * Spam, Trash, Sent or Drafts. A message moved to the bin keeps its stored code
 * until it expires, but nothing should offer it any more.
 */
async function liveCodeOf(
	ctx: QueryCtx,
	message: Doc<'mailMessages'>,
	now: number
): Promise<LiveSignInCode | null> {
	const code = message.signInCode;
	if (!code || code.expiresAt <= now) return null;
	const folder = await ctx.db.get(message.folderId);
	if (folder?.role !== undefined && EXCLUDED_ROLES.has(folder.role)) return null;
	return { ...code, messageId: message._id, mailboxId: message.mailboxId };
}

/**
 * The newest live code or sign-in link across every mailbox the caller reads:
 * their own personal mailboxes and the team inboxes they are a member of, never
 * another person's personal mailbox. Null when none is live. Backs the
 * palette's "Copy latest sign-in code".
 */
export const latestSignInCode = postboxQuery({
	args: {},
	handler: async (ctx, _args, session): Promise<LiveSignInCode | null> => {
		const now = Date.now();
		const mailboxes = await loadAccessibleMailboxes(
			ctx,
			session.userId,
			session.activeOrganizationId
		);
		let latest: { code: LiveSignInCode; receivedAt: number } | null = null;
		for (const mailbox of mailboxes) {
			if (mailbox.status !== 'active') continue;
			// Every live code was received within the last TTL (expiresAt is
			// receivedAt + TTL), so nothing older needs reading.
			const recent = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) =>
					q.eq('mailboxId', mailbox._id).gt('receivedAt', now - SIGN_IN_CODE_TTL_MS)
				)
				.order('desc')
				.take(RECENT_SCAN);
			for (const message of recent) {
				if (latest && message.receivedAt <= latest.receivedAt) break;
				const code = await liveCodeOf(ctx, message, now);
				if (code) {
					latest = { code, receivedAt: message.receivedAt };
					break;
				}
			}
		}
		return latest?.code ?? null;
	},
});

/**
 * One message's live code, for the "Copy code" action of a notification about
 * it. Null when the caller cannot read the message or its code expired.
 */
export const messageSignInCode = postboxQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args, session): Promise<LiveSignInCode | null> => {
		const message = await ctx.db.get(args.messageId);
		if (!message?.signInCode) return null;
		const access = await requireMailboxAccess(ctx, message.mailboxId, 'member', session);
		if (!access.ok) return null;
		return liveCodeOf(ctx, message, Date.now());
	},
});
