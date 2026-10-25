/**
 * Which messages are interpreted.
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
import {
	headerEvidenceFromStoredJson,
	headerEvidenceOf,
	isBulkHeaderForInterpretation,
} from '../../lib/mailEvidence';
import { loadSenderContact, senderEvidenceOf } from '../senderEvidence';

export type InterpretEligibilitySignals = Infer<typeof interpretEligibilitySignalsValidator>;

/** Folder roles whose mail is never interpreted (inbound). */
const EXCLUDED_FOLDERS: ReadonlySet<string> = new Set(['spam', 'junk', 'trash', 'drafts', 'sent']);

/** Categories that, together with a bulk header and an unknown sender, mark bulk mail. */
const BULK_CATEGORIES: ReadonlySet<string> = new Set(['newsletter', 'promotion', 'advertising']);

export type EligibilityVerdict =
	| { isEligible: true }
	| { isEligible: false; skipReason: InterpretationSkipReason; detail: string };

/** Is this message interpreted at all? Pure. */
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

// ── The category the bulk rule reads (PR review PR-4) ──────────────────────

/** How long a run waits for the category model to refine a provisional label. */
export const CATEGORY_SETTLE_MS = 10 * 60 * 1000;

/**
 * A thread category the bulk rule does not decide on yet: none, or the `other`
 * baseline the heuristic writes while the model refinement is scheduled.
 */
export function isProvisionalCategory(category?: { label: string; source: string }): boolean {
	return !category || (category.source === 'heuristic' && category.label === 'other');
}

/**
 * The eligibility a run decides on: the snapshot's immutable ingest signals
 * (live, folder, mute, bulk headers, known sender) with the CATEGORY settled.
 *
 * Delivery snapshots eligibility in the transaction that enqueues the run, but
 * a thread's category may still be the provisional baseline there (`other`,
 * written by `categoryArrival.enqueueCategoryCheck` while the model refinement
 * is scheduled). Freezing that would let a stranger's newsletter through the
 * bulk rule. So, for a bulk-stranger candidate only (bulk header and an
 * unknown sender, inbound): the thread's category is read again when the run
 * starts; while it is still provisional and the capture is younger than
 * {@link CATEGORY_SETTLE_MS}, the run waits (`pendingUntil`); after that, or
 * once the refinement landed, the thread's label is final. Every other
 * message decides on the snapshot as captured. Pure.
 */
export function settleCategory(
	signals: InterpretEligibilitySignals,
	input: {
		threadCategory?: { label: string; source: string };
		capturedAt: number;
		now: number;
		direction?: 'inbound' | 'outbound';
	}
): { signals: InterpretEligibilitySignals } | { pendingUntil: number } {
	if (input.direction === 'outbound' || !signals.isBulkHeaderPresent || signals.isSenderKnown) {
		return { signals };
	}
	const category = input.threadCategory;
	const settlesAt = input.capturedAt + CATEGORY_SETTLE_MS;
	if (isProvisionalCategory(category) && input.now < settlesAt) return { pendingUntil: settlesAt };
	const label = category?.label ?? signals.category;
	return { signals: { ...signals, ...(label ? { category: label } : {}) } };
}

// ── Short and security mail (what a run shows) ─────────────────────────────

/** A fresh part at or under this length, alone in its thread, gets no "Latest update". */
export const SHORT_MAIL_MAX_CHARS = 350;

/** Short mail alone in its thread (see {@link SHORT_MAIL_MAX_CHARS}). */
export function isShortMail(input: { freshChars: number; threadMessageCount: number }): boolean {
	return input.threadMessageCount <= 1 && input.freshChars <= SHORT_MAIL_MAX_CHARS;
}

/** One-time codes and sign-in links in a subject (also the §6.4 code detector's). */
const CODE_SUBJECT = [
	/\b(?:verification|security|login|log-in|sign[- ]?in|one[- ]time|confirmation|access|auth(?:entication)?)\s*(?:code|pin|link)\b/i,
	/\b(?:2fa|two[- ]factor|mfa|otp)\b/i,
	/\b(?:bestätigungscode|sicherheitscode|anmeldecode|einmalcode|verifizierungscode)\b/i,
];

/** A code in the body: "your verification code", "code: 123456". */
const CODE_BODY = [
	/\b(?:your|ihr|dein|votre) (?:verification|security|login|one[- ]time|bestätigungs|sicherheits|anmelde)[- ]?(?:code|pin)\b/i,
	/\b(?:code|pin)(?: is|:| lautet| est)\s*[A-Z0-9]{4,10}\b/i,
];

const SECURITY_SUBJECT = [
	...CODE_SUBJECT,
	/\b(?:password|passcode)\s*(?:reset|change|recovery)\b/i,
	/\breset (?:your )?password\b/i,
	/\b(?:new|unusual|suspicious) (?:sign[- ]?in|login|log-in|device|activity)\b/i,
	/\bpasswort (?:zurücksetzen|ändern|vergessen)\b/i,
	/\bneue anmeldung\b/i,
	/\b(?:code de (?:vérification|sécurité|connexion)|réinitialis\w* (?:de )?(?:votre |ton )?mot de passe)\b/i,
];

const SECURITY_BODY = [...CODE_BODY, /\breset (?:your )?password\b/i, /\bpasswort zurücksetzen\b/i];

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

/**
 * One-time codes and sign-in links, for the opt-in "archive after a day"
 * detector: the code patterns of the security screen above,
 * without password resets or login alerts, which stay put. Pure.
 */
export function isCodeOrSignInMail(input: { subject?: string; text: string }): boolean {
	const subject = input.subject ?? '';
	if (CODE_SUBJECT.some((re) => re.test(subject))) return true;
	const head = input.text.slice(0, 2000);
	return CODE_BODY.some((re) => re.test(head));
}

// ── Loaders ────────────────────────────────────────────────────────────────

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
	const contact = await loadSenderContact(
		ctx,
		message.mailboxId,
		normalizeEmail(message.fromAddress)
	);
	const category = thread?.category?.label;
	return {
		isLive: opts.isLive,
		...(folder?.role ? { folder: folder.role } : {}),
		isThreadMuted: thread?.mutedAt !== undefined,
		isBulkHeaderPresent: isBulkHeaderForInterpretation(
			headerEvidenceOf({
				...(opts.precedence !== undefined ? { precedence: opts.precedence } : {}),
				...(opts.listId !== undefined ? { listId: opts.listId } : {}),
				hasListUnsubscribe: message.unsubscribe !== undefined,
			}),
			'non_empty'
		),
		isSenderKnown: senderEvidenceOf(contact).hasCorresponded,
		...(category ? { category } : {}),
	};
}

/** Bound on the sent-reply scan that decides whether the team knows a contact. */
const KNOWN_CONTACT_SCAN = 50;

/** Signals of a Team Inbox message (always live: the pipeline only sees new mail). */
export async function loadInboundEligibilitySignals(
	ctx: Pick<QueryCtx, 'db'>,
	message: Doc<'inboundMessages'>
): Promise<InterpretEligibilitySignals> {
	const isBulkHeaderPresent = isBulkHeaderForInterpretation(
		headerEvidenceFromStoredJson(message.headers),
		'present'
	);
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
