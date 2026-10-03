/**
 * Inbox processing lifecycle — the draft fields a `→ draft_ready` transition
 * writes, and the saved-edit history a new agent draft starts without. Pure;
 * split out of `./reducers.ts` to hold it under the size cap.
 */

import type { Doc } from '../../_generated/dataModel';
import { authoredDraftHasGaps } from '../../agent/shared/draftGaps';
import { CLEARS_DRAFT_ON_TAKEOVER } from './takeover';
import type { InputFor } from './types';

/**
 * A person's saves over one agent draft (inbox/draftRevisions.ts): revision 0
 * is that draft, `draftSavedAt` pins the row in the review queue as saved
 * work, and `isDraftEdited` says the working text differs from revision 0.
 * They describe that draft only. A new agent draft, or a reopen that drops the
 * draft, clears them, so the next save seeds the current draft as revision 0
 * and an unchanged approve records no `'edited'` signal.
 */
export const NO_SAVED_EDITS = {
	draftRevisions: undefined,
	draftSavedAt: undefined,
	isDraftEdited: undefined,
} as const;

/** The draft half of the `→ draft_ready` patch. */
export function draftReadyDraftPatch(
	message: Doc<'inboundMessages'>,
	input: InputFor<'draft_ready'>
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	if (input.draftResponse !== undefined) {
		patch['draftResponse'] = input.draftResponse;
		// Variants stay only while they are this draft's (`draftOptions[0]` is the
		// draft). The `[[...]]` gap guard counts them, as `recordDraftOutput` does.
		const kept = message.draftOptions?.[0] === input.draftResponse ? message.draftOptions : [];
		if (kept.length === 0) patch['draftOptions'] = undefined;
		const texts = [input.draftResponse, ...kept];
		patch['isDraftGapGuarded'] = texts.some((text) => authoredDraftHasGaps({ text }));
		// An agent draft that replaces a different text: the saved edits were
		// made to that text, not to this draft.
		if (input.draftResponse !== message.draftResponse) Object.assign(patch, NO_SAVED_EDITS);
	}
	if (input.draftSubject !== undefined) patch['draftSubject'] = input.draftSubject;
	// A person reopening a closed message writes the reply themselves. The draft
	// it still carries was thrown out (rejected) or never used (archived); left
	// in place it would come back as a live, approvable agent draft. Its gap
	// guard and the edits saved over it go with it: the person's own double
	// brackets are their text, and an empty draft is nobody's saved work.
	if (input.manualTakeover === true && CLEARS_DRAFT_ON_TAKEOVER.has(message.processingStatus)) {
		Object.assign(patch, NO_SAVED_EDITS, {
			draftResponse: undefined,
			draftSubject: undefined,
			draftOptions: undefined,
			isDraftGapGuarded: undefined,
		});
	}
	return patch;
}
