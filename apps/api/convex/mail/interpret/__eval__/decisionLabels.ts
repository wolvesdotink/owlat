/**
 * Decision labels for the eval corpus (AI routing plan, Phase 1a and
 * "Evaluation and release policy"). Beside the interpretation labels
 * (`corpus.ts`), every thread carries one or more `labels.decisions` entries,
 * each about one INBOUND message, with what a correct answer to each bounded
 * judgment is:
 *
 *   - `triage`: the message-only pre-filter (D11). `spam`: unsolicited,
 *     deceptive or fraudulent; `automated`: sent by a system rather than
 *     written by a person for this recipient (notifications, receipts,
 *     newsletters, promotions, invitations); `needs_work`: a person asks the
 *     mailbox owner to do or answer something; `no_work`: a person wrote it but
 *     asks nothing of the owner (thanks, updates, mail addressed to others).
 *   - `postboxCategory` / `teamCategory`: the category in the domain of the
 *     surface the thread belongs to (`brief` threads are Postbox mail, `actions`
 *     threads Team Inbox mail). The two domains differ, so each is its own task.
 *   - `disposition`: `reply` when the sender expects a written reply from the
 *     owner, `informational` otherwise (the domain `resolveResponseDisposition`
 *     answers in today).
 *   - `clarification.necessity` (reply messages only): `needed` when an
 *     acceptable reply needs a value the thread does not hold and the sender is
 *     not the one to supply it (a date, an amount, a choice, an approval, a file,
 *     a fact about the owner's work); `not_needed` when the reply can be written
 *     from the thread, including a reply that asks the SENDER for what is
 *     missing. `missing` names the values, for a human reader. An acceptable
 *     holding reply ("I'll look into it and get back to you") is a reply
 *     written from the thread, so a `needed` message never has an accepted
 *     draft; the loader refuses one.
 *   - `drafts` (reply messages only): candidate replies with the owner's
 *     verdict. `accept`: sent as is; `edit`: right idea, needs a material edit;
 *     `reject`: wrong language, invented facts or commitments, or obeys
 *     instructions planted in the mail. An accepted or edit-labelled draft
 *     states nothing the thread does not hold: no outcome it cannot see
 *     ("cancelled", "refund issued"), no confirmation the owner has not given
 *     ("works for me"), and no substantive commitment ("I'll send", "we'll
 *     refund"). It acknowledges, holds ("I'll look into it", "we'll get back
 *     to you"), or asks the sender. {@link unbackedClaims} enforces the
 *     phrases of that rule on every corpus load.
 *   - `senderKnown`: context, not a label. Whether the owner already
 *     corresponds with the sender (the address-book signal today's Postbox
 *     heuristic reads). Absent: derived from the thread (an earlier outbound
 *     message to the sender).
 *
 * Every thread also names its `split` (`train`, `calibration`, `heldout`):
 * prompts and criteria are developed on training threads, thresholds and
 * calibration maps are fitted on calibration threads, and only held-out
 * threads are reported (`splits.ts`).
 *
 * Pure and isolate-safe.
 */
import { z } from 'zod';

export const EVAL_SPLITS = ['train', 'calibration', 'heldout'] as const;
export type EvalSplit = (typeof EVAL_SPLITS)[number];

/** The Postbox category domain (`mailCategoryLabelValidator`). */
export const POSTBOX_CATEGORIES = [
	'person',
	'newsletter',
	'notification',
	'receipt',
	'promotion',
	'spam',
	'other',
] as const;

/** The Team Inbox category domain (the `classify` step's schema). */
export const TEAM_CATEGORIES = [
	'support',
	'sales',
	'billing',
	'feature_request',
	'complaint',
	'spam',
	'internal',
	'other',
] as const;

export const TRIAGE_CLASSES = ['spam', 'automated', 'needs_work', 'no_work'] as const;
export const DISPOSITIONS = ['reply', 'informational'] as const;
export const NECESSITY_CLASSES = ['needed', 'not_needed'] as const;
export const DRAFT_ACCEPTANCE = ['accept', 'edit', 'reject'] as const;

export type TriageClass = (typeof TRIAGE_CLASSES)[number];
export type Disposition = (typeof DISPOSITIONS)[number];

const draftLabel = z
	.object({
		id: z.string(),
		text: z.string().min(1),
		acceptance: z.enum(DRAFT_ACCEPTANCE),
		/** Why the owner would (not) send it, for a human reader. */
		reason: z.string(),
	})
	.strict();

export const decisionLabelSchema = z
	.object({
		messageId: z.string(),
		triage: z.enum(TRIAGE_CLASSES),
		disposition: z.enum(DISPOSITIONS),
		postboxCategory: z.enum(POSTBOX_CATEGORIES).optional(),
		teamCategory: z.enum(TEAM_CATEGORIES).optional(),
		clarification: z
			.object({
				necessity: z.enum(NECESSITY_CLASSES),
				missing: z.array(z.string()).optional(),
			})
			.strict()
			.optional(),
		drafts: z.array(draftLabel).optional(),
		senderKnown: z.boolean().optional(),
	})
	.strict();

export type DecisionLabel = z.infer<typeof decisionLabelSchema>;
export type DraftLabel = NonNullable<DecisionLabel['drafts']>[number];

/** What `checkDecisionLabels` needs of a thread (kept structural to avoid a cycle with `corpus.ts`). */
interface LabelledThread {
	id: string;
	mode: 'brief' | 'actions';
	messages: readonly {
		id: string;
		direction: 'inbound' | 'outbound';
		subject: string;
		text?: string;
		html?: string;
	}[];
	labels: { decisions: readonly DecisionLabel[] };
}

/**
 * Phrases that claim an outcome, give a confirmation or make a substantive
 * commitment (EN and DE). A draft labelled `accept` or `edit` may use one only
 * where the thread itself says it; otherwise the draft is a `reject`.
 * Curated, not exhaustive: it is the floor under the rule, not the rule.
 */
export const CLAIM_PHRASES: readonly string[] = [
	// Outcomes and confirmations
	'confirmed',
	'i confirm',
	'we confirm',
	'has been',
	'have been',
	"we've noted",
	'we have noted',
	'processed',
	'cancelled',
	'canceled',
	'refunded',
	'refund issued',
	'issued',
	'is done',
	'all set',
	'will arrive',
	'will be delivered',
	'shipped',
	'approved',
	'signed and',
	'booked',
	'works for me',
	'is fine with me',
	"let's move",
	'ends on',
	'marked as paid',
	'transfer is done',
	'erledigt',
	'bestätigt',
	'storniert',
	'gekündigt',
	'erstattet',
	'zurückgesetzt',
	'überwiesen',
	'freigegeben',
	'unterschrieben',
	'gebucht',
	'passt mir',
	'wird geliefert',
	'kommt am',
	// Substantive commitments
	"i'll send",
	'i will send',
	"we'll send",
	'we will send',
	"i'll take care",
	"i'll make sure",
	"i'll pay",
	"we'll refund",
	"we'll replace",
	'ich schicke',
	'wir schicken',
	'ich kümmere mich',
	'wir kümmern uns',
	'ich organisiere',
	'ich lese',
	'ich überweise',
	'wir setzen',
];

/** A phrase as a whole-word, case-insensitive pattern. Phrases hold only letters, spaces and apostrophes. */
const claimPattern = (phrase: string) => new RegExp(`(?<!\\p{L})${phrase}(?!\\p{L})`, 'iu');

/** The claim phrases in `draft` that the thread's own text does not contain. */
export function unbackedClaims(draft: string, threadText: string): string[] {
	return CLAIM_PHRASES.filter((phrase) => {
		const pattern = claimPattern(phrase);
		return pattern.test(draft) && !pattern.test(threadText);
	});
}

/** Throw on a decision label that contradicts its thread or itself. */
export function checkDecisionLabels(thread: LabelledThread): void {
	const fail = (message: string) => {
		throw new Error(`${thread.id}: ${message}`);
	};
	const seen = new Set<string>();
	const threadText = thread.messages
		.map((m) => `${m.subject}\n${m.text ?? m.html ?? ''}`)
		.join('\n');
	for (const label of thread.labels.decisions) {
		const message = thread.messages.find((m) => m.id === label.messageId);
		if (!message) fail(`decision names unknown message ${label.messageId}`);
		if (message?.direction !== 'inbound') fail(`decision on ${label.messageId} is not inbound`);
		if (seen.has(label.messageId)) fail(`two decisions on ${label.messageId}`);
		seen.add(label.messageId);

		const category = thread.mode === 'brief' ? label.postboxCategory : label.teamCategory;
		if (category === undefined) {
			fail(`${label.messageId} needs a ${thread.mode === 'brief' ? 'postbox' : 'team'} category`);
		}
		if ((label.triage === 'spam') !== (category === 'spam')) {
			fail(`${label.messageId}: triage spam and category spam must agree`);
		}
		if (label.triage !== 'needs_work' && label.disposition === 'reply') {
			fail(`${label.messageId}: only needs_work mail can expect a reply`);
		}
		if ((label.disposition === 'reply') !== (label.clarification !== undefined)) {
			fail(`${label.messageId}: clarification is labelled exactly for reply messages`);
		}
		// An accepted draft is a reply written without the owner's input, which is
		// exactly what `needed` says cannot exist: the two labels must agree.
		if (
			label.clarification?.necessity === 'needed' &&
			label.drafts?.some((d) => d.acceptance === 'accept')
		) {
			fail(`${label.messageId}: needs the owner, yet a draft is accepted as is`);
		}
		if (label.drafts && label.disposition !== 'reply') {
			fail(`${label.messageId}: drafts are labelled only for reply messages`);
		}
		for (const draft of label.drafts ?? []) {
			if (draft.acceptance === 'reject') continue;
			const claims = unbackedClaims(draft.text, threadText);
			if (claims.length > 0) {
				fail(
					`${label.messageId}/${draft.id} is ${draft.acceptance} but claims: ${claims.join(', ')}`
				);
			}
		}
		const draftIds = new Set(label.drafts?.map((d) => d.id));
		if (draftIds.size !== (label.drafts?.length ?? 0))
			fail(`${label.messageId}: duplicate draft id`);
	}
}
