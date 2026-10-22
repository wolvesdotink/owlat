/**
 * The catalog entries of the surfaces outside the Postbox: the composer, the
 * Team inbox, the Workbench and its peek panel, Answer mode and the desktop
 * workspaces. Spread into `SHORTCUT_CATALOG` after the Postbox, in this order,
 * which is the order their groups appear on the shortcuts page.
 *
 * The Team inbox, Workbench and peek entries are bound through the app-wide
 * dispatcher (`useKeyboardShortcuts`) by the surface that claims the scope, so
 * they can be remapped. Answer mode still answers its keys in its own
 * handlers; its entries document them and stay fixed.
 */

import type { ShortcutDefinition } from './shortcutRegistry';
import {
	FIXED_CONVENTION as CONVENTION,
	FIXED_LAYOUT as LAYOUT,
	FIXED_SURFACE as SURFACE,
	SHORTCUT_GROUPS as G,
	shortcutLabelKey as L,
} from './shortcutCatalogParts';

export const SURFACE_SHORTCUTS: readonly ShortcutDefinition[] = [
	// --- Composer (bound on the composer root, not the window) ----------------
	{
		id: 'composer.send',
		scope: 'composer',
		keys: ['mod+Enter'],
		labelKey: L('send'),
		groupKey: G.compose,
		...CONVENTION,
	},
	{
		id: 'composer.schedule',
		scope: 'composer',
		keys: ['mod+shift+Enter'],
		labelKey: L('scheduleSend'),
		groupKey: G.compose,
		...CONVENTION,
	},
	{
		id: 'composer.minimize',
		scope: 'composer',
		keys: ['Escape'],
		labelKey: L('minimizeComposer'),
		groupKey: G.compose,
		...CONVENTION,
	},
	{
		// Both composers bind it themselves (useComposerSavedReplyPicker).
		id: 'composer.savedReplies',
		scope: 'composer',
		keys: ['mod+;'],
		labelKey: L('savedReplies'),
		groupKey: G.compose,
		...SURFACE,
	},

	// --- Review lists (the Team inbox Updates page) --------------------------
	{
		id: 'review.next',
		scope: 'review',
		keys: ['j', 'ArrowDown'],
		labelKey: L('next'),
		groupKey: G.review,
	},
	{
		id: 'review.previous',
		scope: 'review',
		keys: ['k', 'ArrowUp'],
		labelKey: L('previous'),
		groupKey: G.review,
	},
	{
		id: 'review.open',
		scope: 'review',
		keys: ['Enter'],
		labelKey: L('openThread'),
		groupKey: G.review,
		...CONVENTION,
	},

	// --- Team inbox threads (claimed by the thread page; `i` also works on a
	// focused row of the list) --------------------------------------------------
	{
		id: 'inbox.assignToMe',
		scope: 'inbox',
		keys: ['i'],
		labelKey: L('assignToMe'),
		groupKey: G.teamInbox,
	},
	{
		id: 'inbox.reply',
		scope: 'inbox',
		keys: ['r'],
		labelKey: L('replyInAnswerMode'),
		groupKey: G.teamInbox,
	},
	{
		id: 'inbox.note',
		scope: 'inbox',
		keys: ['n'],
		labelKey: L('writeNote'),
		groupKey: G.teamInbox,
	},

	// --- Workbench (the dashboard's lines) and the peek panel over it ---------
	{
		id: 'workbench.next',
		scope: 'workbench',
		keys: ['j'],
		labelKey: L('nextLine'),
		groupKey: G.workbench,
	},
	{
		id: 'workbench.previous',
		scope: 'workbench',
		keys: ['k'],
		labelKey: L('previousLine'),
		groupKey: G.workbench,
	},
	{
		id: 'workbench.open',
		scope: 'workbench',
		keys: ['Enter'],
		labelKey: L('openLine'),
		groupKey: G.workbench,
		...CONVENTION,
	},
	{
		id: 'workbench.done',
		scope: 'workbench',
		keys: ['d'],
		labelKey: L('markLineDone'),
		groupKey: G.workbench,
	},
	{
		id: 'workbench.reply',
		scope: 'workbench',
		keys: ['r'],
		labelKey: L('replyToUpdate'),
		groupKey: G.workbench,
	},
	{
		id: 'peek.next',
		scope: 'peek',
		keys: ['j', 'ArrowDown'],
		labelKey: L('nextPeekEmail'),
		groupKey: G.workbench,
	},
	{
		id: 'peek.previous',
		scope: 'peek',
		keys: ['k', 'ArrowUp'],
		labelKey: L('previousPeekEmail'),
		groupKey: G.workbench,
	},
	{
		// Through the shared Escape stack (useEscapeLayer), like every panel.
		id: 'peek.close',
		scope: 'peek',
		keys: ['Escape'],
		labelKey: L('closePeek'),
		groupKey: G.workbench,
		...CONVENTION,
	},

	// --- Answer mode (claimed by AnswerModeFrame; the pages, the queue bar and
	// the ask card bind these keys themselves, so the entries document them for
	// the "?" sheet and none can be remapped) ------------------------------------
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
		...SURFACE,
	},
	{
		id: 'answer.writeNote',
		scope: 'answer',
		keys: ['n'],
		labelKey: L('writeNote'),
		groupKey: G.answer,
		...SURFACE,
	},
	{
		id: 'answer.draftWithAi',
		scope: 'answer',
		keys: ['mod+j'],
		labelKey: L('draftWithAi'),
		groupKey: G.answer,
		...SURFACE,
	},
	{
		id: 'answer.pickAskOption',
		scope: 'answer',
		keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
		displayKeys: '1–9',
		labelKey: L('pickAskOption'),
		groupKey: G.answer,
		...SURFACE,
	},
	{
		id: 'answer.previousItem',
		scope: 'answer',
		keys: ['['],
		labelKey: L('previousQueueItem'),
		groupKey: G.answer,
		...SURFACE,
	},
	{
		id: 'answer.nextItem',
		scope: 'answer',
		keys: [']'],
		labelKey: L('nextQueueItem'),
		groupKey: G.answer,
		...SURFACE,
	},
	{
		id: 'answer.archive',
		scope: 'answer',
		keys: ['e'],
		labelKey: L('archive'),
		groupKey: G.answer,
		...SURFACE,
	},
	{
		id: 'answer.snooze',
		scope: 'answer',
		keys: ['h'],
		labelKey: L('snooze'),
		groupKey: G.answer,
		...SURFACE,
	},
	{
		id: 'answer.undo',
		scope: 'answer',
		keys: ['mod+z'],
		labelKey: L('undoQueueStep'),
		groupKey: G.answer,
		...CONVENTION,
	},

	// --- Desktop workspaces ---------------------------------------------------
	{
		id: 'workspace.switch',
		scope: 'workspace',
		keys: ['mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5', 'mod+6', 'mod+7', 'mod+8', 'mod+9'],
		displayKeys: 'mod+1–9',
		labelKey: L('switchWorkspace'),
		groupKey: G.workspace,
		...LAYOUT,
	},
];
