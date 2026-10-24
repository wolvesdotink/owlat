/**
 * The catalog entries of Answer mode and the Answer queue, spread into
 * `SURFACE_SHORTCUTS` in this order.
 *
 * Every one of them is bound through the app-wide dispatcher
 * (`useKeyboardShortcuts`). The queue's cards reuse keys (Enter is "done" on a
 * follow-up, "send" on a team draft, "open" on a mention, and `s` skips more
 * than one kind), so each card kind claims a scope of its own while it is on
 * screen: only one card shows at a time, and one press means one thing.
 *
 *   - `answer`: the Answer mode page (AnswerModeFrame claims it; the pages and
 *     the queue bar bind the keys).
 *   - `answerQueue`: the queue session, live on the queue page and on every
 *     Answer mode page under it.
 *   - `askCard`: the AI's question card, wherever it is shown.
 *   - `mailCard`, `teamCard`, `mentionCard`: the queue page's card in focus.
 */

import type { ShortcutDefinition } from './shortcutRegistry';
import {
	FIXED_CONVENTION as CONVENTION,
	FIXED_NUMBERED as NUMBERED,
	SHORTCUT_GROUPS as G,
	shortcutLabelKey as L,
} from './shortcutCatalogParts';

export const ANSWER_SHORTCUTS: readonly ShortcutDefinition[] = [
	// --- Answer mode ----------------------------------------------------------
	{
		id: 'answer.leave',
		scope: 'answer',
		keys: ['Escape'],
		labelKey: L('leaveAnswerMode'),
		groupKey: G.answer,
		...CONVENTION,
	},
	{
		id: 'answer.toggleView',
		scope: 'answer',
		keys: ['t'],
		labelKey: L('toggleAnswerView'),
		groupKey: G.answer,
	},
	{
		// Team inbox threads only; the personal page has no notes.
		id: 'answer.writeNote',
		scope: 'answer',
		keys: ['n'],
		labelKey: L('writeNote'),
		groupKey: G.answer,
	},
	{
		// The same chord as the app-wide Assistant: a nearer scope wins it.
		id: 'answer.draftWithAi',
		scope: 'answer',
		keys: ['mod+j'],
		labelKey: L('draftWithAi'),
		groupKey: G.answer,
	},
	{
		// The queue bar's keys, live while the page is part of a queue.
		id: 'answer.previousItem',
		scope: 'answer',
		keys: ['['],
		labelKey: L('previousQueueItem'),
		groupKey: G.answer,
	},
	{
		id: 'answer.nextItem',
		scope: 'answer',
		keys: [']'],
		labelKey: L('nextQueueItem'),
		groupKey: G.answer,
	},
	{
		id: 'answer.archive',
		scope: 'answer',
		keys: ['e'],
		labelKey: L('archive'),
		groupKey: G.answer,
	},
	{
		id: 'answer.snooze',
		scope: 'answer',
		keys: ['h'],
		labelKey: L('snooze'),
		groupKey: G.answer,
	},

	// --- The queue session ----------------------------------------------------
	{
		id: 'answerQueue.undo',
		scope: 'answerQueue',
		keys: ['mod+z'],
		labelKey: L('undoQueueStep'),
		groupKey: G.answer,
		...CONVENTION,
	},

	// --- The AI's question card -----------------------------------------------
	{
		id: 'askCard.pickOption',
		scope: 'askCard',
		keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
		displayKeys: '1–9',
		labelKey: L('pickAskOption'),
		groupKey: G.answer,
		...NUMBERED,
	},

	// --- Queue cards: a follow-up reminder --------------------------------------
	{
		id: 'mailCard.done',
		scope: 'mailCard',
		keys: ['Enter'],
		labelKey: L('markFollowUpDone'),
		groupKey: G.answer,
		...CONVENTION,
	},
	{
		id: 'mailCard.previous',
		scope: 'mailCard',
		keys: ['k', 'ArrowLeft'],
		labelKey: L('previousCard'),
		groupKey: G.answer,
	},
	{
		id: 'mailCard.next',
		scope: 'mailCard',
		keys: ['j', 'ArrowRight'],
		labelKey: L('nextCard'),
		groupKey: G.answer,
	},

	// --- Queue cards: a Team inbox draft --------------------------------------
	{
		// Sends the reply when the thread needs one, else approves the draft.
		id: 'teamCard.send',
		scope: 'teamCard',
		keys: ['Enter'],
		labelKey: L('sendOrApprove'),
		groupKey: G.answer,
		...CONVENTION,
	},
	{
		id: 'teamCard.approve',
		scope: 'teamCard',
		keys: ['a'],
		labelKey: L('approveDraft'),
		groupKey: G.answer,
	},
	{
		id: 'teamCard.reject',
		scope: 'teamCard',
		keys: ['x'],
		labelKey: L('rejectDraft'),
		groupKey: G.answer,
	},

	// --- Queue cards: a chat mention ------------------------------------------
	{
		id: 'mentionCard.reply',
		scope: 'mentionCard',
		keys: ['Enter'],
		labelKey: L('openMention'),
		groupKey: G.answer,
		...CONVENTION,
	},
	{
		id: 'mentionCard.markRead',
		scope: 'mentionCard',
		keys: ['d'],
		labelKey: L('markMentionRead'),
		groupKey: G.answer,
	},
	{
		id: 'mentionCard.skip',
		scope: 'mentionCard',
		keys: ['s'],
		labelKey: L('skipCard'),
		groupKey: G.answer,
	},
];
