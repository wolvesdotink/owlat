/**
 * Which messages are interpreted (SPEC §4 eligibility, D2).
 *
 * {@link isInterpretationEligible} is pure over the persisted
 * {@link InterpretEligibilitySignals}; the loaders below read them once, and
 * the run stores them on `messageInterpretations.eligibility`, so a retry
 * decides on the same inputs even after a folder move or a mute.
 *
 * An inbound message is eligible when it is live (delivered now, not a history
 * backfill or an IMAP APPEND), sits in a real folder (not spam, trash, drafts
 * or sent), and its thread is not muted. Bulk mail from strangers is excluded,
 * but only when ALL THREE signals agree: a List-Unsubscribe / Precedence
 * bulk-or-list header, a sender the owner (or the inbox) never wrote to, and a
 * bulk category (Postbox `newsletter|promotion`, team `newsletter|advertising`).
 * One signal alone is not enough: a known sender's list mail and a stranger's
 * personal mail are both read.
 *
 * Outbound sources (our own sent mail) skip the folder rule: sent is where
 * they live.
 *
 * The short-mail and security-mail rules decide what a run SHOWS, not whether
 * it runs: items are still extracted, only the "Latest update" is withheld
 * (and security mail keeps the original as the primary view).
 */

import type { Infer } from 'convex/values';
import type { Doc } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { normalizeEmail } from '@owlat/shared';
import type { InterpretationSkipReason } from '@owlat/shared/threadBrief';
import type { interpretEligibilitySignalsValidator } from '../../lib/validators/threadBrief';

export type InterpretEligibilitySignals = Infer<typeof interpretEligibilitySignalsValidator>;

/** Folder roles whose mail is never interpreted (inbound). */
const EXCLUDED_FOLDERS: ReadonlySet<string> = new Set(['spam', 'junk', 'trash', 'drafts', 'sent']);

/** Categories that, together with a bulk header and an unknown sender, mark bulk mail. */
const BULK_CATEGORIES: ReadonlySet<string> = new Set(['newsletter', 'promotion', 'advertising']);

export type EligibilityVerdict =
	| { isEligible: true }
	| { isEligible: false; skipReason: InterpretationSkipReason; detail: string };

/** SPEC §4: is this message interpreted at all? Pure. */
export function isInterpretationEligible(
	signals: InterpretEligibilitySignals,
	options: { direction?: 'inbound' | 'outbound' } = {}
): EligibilityVerdict {
	if (!signals.isLive) return { isEligible: false, skipReason: 'ineligible', detail: 'not_live' };
	if (signals.isThreadMuted)
		return { isEligible: false, skipReason: 'ineligible', detail: 'muted' };
	if (
		options.direction !== 'outbound' &&
		signals.folder !== undefined &&
		EXCLUDED_FOLDERS.has(signals.folder)
	) {
		return { isEligible: false, skipReason: 'ineligible', detail: `folder_${signals.folder}` };
	}
	if (
		signals.isBulkHeaderPresent &&
		!signals.isSenderKnown &&
		signals.category !== undefined &&
		BULK_CATEGORIES.has(signals.category)
	) {
		return { isEligible: false, skipReason: 'bulk', detail: 'bulk_stranger' };
	}
	return { isEligible: true };
}

// ── Short and security mail (what a run shows) ─────────────────────────────

/** A fresh part at or under this length, alone in its thread, gets no "Latest update". */
export const SHORT_MAIL_MAX_CHARS = 350;

/** SPEC §4 short-mail rule. */
export function isShortMail(input: { freshChars: number; threadMessageCount: number }): boolean {
	return input.threadMessageCount <= 1 && input.freshChars <= SHORT_MAIL_MAX_CHARS;
}

const SECURITY_SUBJECT = [
	/\b(?:verification|security|login|log-in|sign[- ]?in|one[- ]time|confirmation|access|auth(?:entication)?)\s*(?:code|pin|link)\b/i,
	/\b(?:password|passcode)\s*(?:reset|change|recovery)\b/i,
	/\breset (?:your )?password\b/i,
	/\b(?:new|unusual|suspicious) (?:sign[- ]?in|login|log-in|device|activity)\b/i,
	/\b(?:2fa|two[- ]factor|mfa|otp)\b/i,
	/\b(?:bestätigungscode|sicherheitscode|anmeldecode|einmalcode|verifizierungscode)\b/i,
	/\bpasswort (?:zurücksetzen|ändern|vergessen)\b/i,
	/\bneue anmeldung\b/i,
	/\b(?:code de (?:vérification|sécurité|connexion)|réinitialis\w* (?:de )?(?:votre |ton )?mot de passe)\b/i,
];

const SECURITY_BODY = [
	/\b(?:your|ihr|dein|votre) (?:verification|security|login|one[- ]time|bestätigungs|sicherheits|anmelde)[- ]?(?:code|pin)\b/i,
	/\b(?:code|pin)(?: is|:| lautet| est)\s*[A-Z0-9]{4,10}\b/i,
	/\breset (?:your )?password\b/i,
	/\bpasswort zurücksetzen\b/i,
];

/**
 * Security mail (codes, password resets, login alerts): no "Latest update",
 * the original stays the primary view. Pure; conservative patterns over the
 * subject and the fresh text.
 */
export function isSecurityMail(input: { subject?: string; freshText: string }): boolean {
	const subject = input.subject ?? '';
	if (SECURITY_SUBJECT.some((re) => re.test(subject))) return true;
	const head = input.freshText.slice(0, 2000);
	return SECURITY_BODY.some((re) => re.test(head));
}

// ── Loaders ────────────────────────────────────────────────────────────────

/** Precedence values that mark list or bulk mail. */
function isBulkPrecedence(precedence: string | undefined): boolean {
	return !!precedence && /^\s*(?:bulk|list|junk)\b/i.test(precedence);
}

/**
 * Signals of a Postbox message. `isLive` and the ingest-only headers come from
 * the caller (the delivery pipeline knows whether this is live delivery and
 * sees Precedence / List-Id, which are not persisted).
 */
export async function loadMailEligibilitySignals(
	ctx: Pick<QueryCtx, 'db'>,
	message: Doc<'mailMessages'>,
	opts: { isLive: boolean; precedence?: string; listId?: string }
): Promise<InterpretEligibilitySignals> {
	const [folder, thread] = await Promise.all([
		ctx.db.get(message.folderId),
		ctx.db.get(message.threadId),
	]);
	const contact = await ctx.db
		.query('mailContacts')
		.withIndex('by_mailbox_and_email', (q) =>
			q.eq('mailboxId', message.mailboxId).eq('email', normalizeEmail(message.fromAddress))
		)
		.first();
	const category = thread?.category?.label;
	return {
		isLive: opts.isLive,
		...(folder?.role ? { folder: folder.role } : {}),
		isThreadMuted: thread?.mutedAt !== undefined,
		isBulkHeaderPresent:
			message.unsubscribe !== undefined || isBulkPrecedence(opts.precedence) || !!opts.listId,
		isSenderKnown: (contact?.useCount ?? 0) > 0,
		...(category ? { category } : {}),
	};
}

/** Header lookup in the stored inbound `headers` JSON (array of pairs or an object). */
function inboundHeader(headersJson: string | undefined, name: string): string | undefined {
	if (!headersJson) return undefined;
	try {
		const parsed: unknown = JSON.parse(headersJson);
		const lower = name.toLowerCase();
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (Array.isArray(entry) && String(entry[0]).toLowerCase() === lower) {
					return String(entry[1]);
				}
				if (entry && typeof entry === 'object' && 'key' in entry && 'value' in entry) {
					const pair = entry as { key: unknown; value: unknown };
					if (String(pair.key).toLowerCase() === lower) return String(pair.value);
				}
			}
			return undefined;
		}
		if (parsed && typeof parsed === 'object') {
			for (const [key, value] of Object.entries(parsed)) {
				if (key.toLowerCase() === lower)
					return Array.isArray(value) ? String(value[0]) : String(value);
			}
		}
	} catch {
		// Unparseable headers read as absent.
	}
	return undefined;
}

/** Bound on the sent-reply scan that decides whether the team knows a contact. */
const KNOWN_CONTACT_SCAN = 50;

/** Signals of a Team Inbox message (always live: the pipeline only sees new mail). */
export async function loadInboundEligibilitySignals(
	ctx: Pick<QueryCtx, 'db'>,
	message: Doc<'inboundMessages'>
): Promise<InterpretEligibilitySignals> {
	const precedence = inboundHeader(message.headers, 'precedence');
	const isBulkHeaderPresent =
		inboundHeader(message.headers, 'list-unsubscribe') !== undefined ||
		inboundHeader(message.headers, 'list-id') !== undefined ||
		isBulkPrecedence(precedence);
	let isSenderKnown = false;
	if (message.contactId) {
		const prior = await ctx.db
			.query('inboundMessages')
			.withIndex('by_contact', (q) => q.eq('contactId', message.contactId))
			.order('desc')
			.take(KNOWN_CONTACT_SCAN);
		isSenderKnown = prior.some((m) => m._id !== message._id && m.processingStatus === 'sent');
	}
	const kind = message.classification?.kind;
	return {
		isLive: true,
		isThreadMuted: false,
		isBulkHeaderPresent,
		isSenderKnown,
		...(kind ? { category: kind } : {}),
	};
}
