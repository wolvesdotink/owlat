/**
 * The Postbox LIST row: a slim projection of a message plus its thread state.
 *
 * Every list read that returns message rows (the flat `listMessages` and
 * `listByLabel` in `queries.ts`, the split-inbox `listSections` in
 * `mail/sections.ts`, the mailbox `search`) passes its page through
 * {@link toMailListRow}, and the thread-scoped ones through
 * {@link attachThreadState}, so the rows carry one shape whichever renderer
 * shows them.
 *
 * A row carries what the list, the reader header and the offline row cache
 * render (plan 2.3): identity, sender and recipients, subject, snippet, flags,
 * labels, the attachment metadata, dates, section, the sender-trust and
 * security-badge inputs, and the thread's chip state. It never carries a body:
 * no inline text/html (sealed at rest, up to 64 KB each, which every row used
 * to unseal on every run), no `searchBody`, no storage handles, no References
 * chain, no outbound delivery log. The reader renders bodies from its own
 * queries (`mailbox/messages.ts` `listThreadMessages` / `getMessage`), which
 * still unseal at their read boundary.
 *
 * A message row also renders chips that live on its THREAD, not on the message:
 * the follow-up watch, the mute marker, the back-from-snooze marker and the
 * smart-inbox category. {@link attachThreadState} joins them in so no client has
 * to join a second, capped thread subscription to recover a field the server
 * already read.
 *
 * Not a Convex function; a helper shared by the list reads.
 */

import type { Infer } from 'convex/values';
import type { QueryCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import type { mailCategoryLabelValidator } from '../../lib/literalValidators';
import { batchGet } from '../../_utils/batchLoader';

/**
 * The fields a list row keeps, as an allowlist: a field added to `mailMessages`
 * stays off the wire until someone decides a list needs it. Keep bodies and
 * other unbounded columns out.
 */
const MAIL_LIST_ROW_KEYS = [
	'_id',
	'_creationTime',
	'mailboxId',
	'folderId',
	'threadId',
	'fromAddress',
	'fromName',
	'toAddresses',
	'ccAddresses',
	'replyToAddress',
	'subject',
	'snippet',
	'attachments',
	'hasAttachments',
	'flagSeen',
	'flagFlagged',
	'flagAnswered',
	'flagDraft',
	'labelIds',
	'trashedAt',
	'snoozedUntil',
	'isSnoozeUntilReply',
	'pinnedSection',
	'unsubscribe',
	'receivedAt',
	'spamVerdict',
	'virusVerdict',
	'spfResult',
	'dkimResult',
	'dmarcResult',
	'dmarcPolicy',
	'envelopeFromDomain',
	'dkimSigningDomain',
	'dmarcOverride',
	'arcSealer',
	'senderHeuristics',
	'inboundEncryptionInfo',
	'inboundSignatureInfo',
] as const satisfies ReadonlyArray<keyof Doc<'mailMessages'>>;

/** One message as the list reads return it — no body, see the module note. */
export type MailListRow = Pick<Doc<'mailMessages'>, (typeof MAIL_LIST_ROW_KEYS)[number]>;

/**
 * Project a stored message onto its list row. Only keys the row actually HAS
 * are copied, so an absent optional column never starts travelling as a
 * present `undefined`.
 */
export function toMailListRow(message: Doc<'mailMessages'>): MailListRow {
	const row: Record<string, unknown> = {};
	for (const key of MAIL_LIST_ROW_KEYS) {
		const value = message[key];
		if (value !== undefined) row[key] = value;
	}
	return row as MailListRow;
}

/**
 * Follow-up watch state attached to each list row ("No reply yet" chip /
 * armed-reminder chip in the thread list). One thread get per distinct thread
 * on the page, memoized.
 */
type RowFollowUp = { remindAt: number; dueAt?: number; watched: boolean };

/**
 * Thread-level state a list row renders: the follow-up watch, the mute marker
 * (mail/mute.ts), the transient back-from-snooze marker (mail/snooze.ts) and
 * the smart-inbox category (mail/category.ts) the Today and Bundled views
 * group by. Each key is spread in only when the thread actually has it, so a
 * row without any of them travels with exactly the shape the list had before
 * these existed (an `undefined` never rides as a present key).
 */
export type RowThreadState = {
	followUp?: RowFollowUp;
	mutedAt?: number;
	snoozeReturnedAt?: number;
	category?: Infer<typeof mailCategoryLabelValidator>;
};

export async function attachThreadState(
	ctx: QueryCtx,
	messages: Doc<'mailMessages'>[]
): Promise<Array<MailListRow & RowThreadState>> {
	// A page of messages collapses to far fewer threads; `batchGet` keeps the
	// dedupe and reads what is left in parallel rather than row by row.
	const cache = await batchGet(
		ctx,
		messages.map((m) => m.threadId)
	);
	const out: Array<MailListRow & RowThreadState> = [];
	for (const m of messages) {
		const thread = cache.get(m.threadId) ?? null;
		const followUp = thread?.followUp;
		const category = thread?.category?.label;
		const state: RowThreadState = {
			...(followUp
				? {
						followUp: {
							remindAt: followUp.remindAt,
							dueAt: followUp.dueAt,
							watched: followUp.messageId === m._id,
						},
					}
				: {}),
			...(thread?.mutedAt !== undefined ? { mutedAt: thread.mutedAt } : {}),
			...(thread?.snoozeReturnedAt !== undefined
				? { snoozeReturnedAt: thread.snoozeReturnedAt }
				: {}),
			...(category !== undefined ? { category } : {}),
		};
		out.push({ ...toMailListRow(m), ...state });
	}
	return out;
}
