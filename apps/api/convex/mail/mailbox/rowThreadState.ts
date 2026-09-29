/**
 * Per-row thread state for the Postbox message lists.
 *
 * A message row renders chips that live on its THREAD, not on the message: the
 * follow-up watch, the mute marker, the back-from-snooze marker and the
 * smart-inbox category. Every list read that returns message rows (the flat
 * `listMessages` in `queries.ts`, the split-inbox `listSections` in
 * `mail/sections.ts`) passes its page through {@link attachThreadState}, so the
 * rows carry one shape whichever renderer shows them and no client has to join
 * a second, capped thread subscription to recover a field the server already
 * read.
 *
 * Not a Convex function; a helper shared by the list reads.
 */

import type { Infer } from 'convex/values';
import type { QueryCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import type { mailCategoryLabelValidator } from '../../lib/literalValidators';
import { openMailMessageRow } from '../../lib/messageBody';
import { batchGet } from '../../_utils/batchLoader';

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
): Promise<Array<Doc<'mailMessages'> & RowThreadState>> {
	// A page of messages collapses to far fewer threads; `batchGet` keeps the
	// dedupe and reads what is left in parallel rather than row by row.
	const cache = await batchGet(
		ctx,
		messages.map((m) => m.threadId)
	);
	const out: Array<Doc<'mailMessages'> & RowThreadState> = [];
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
		// E8b: the row's inline bodies are SEALED at rest and the reader renders
		// them straight off the list row, so they are unsealed here — the one
		// place every row in these views passes through on its way out.
		out.push({ ...(await openMailMessageRow(m)), ...state });
	}
	return out;
}
