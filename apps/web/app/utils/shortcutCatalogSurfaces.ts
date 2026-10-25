/**
 * The catalog entries of the surfaces outside the Postbox: the composer, the
 * Chat and Assistant message boxes, the Team inbox, the Workbench and its peek
 * panel, Answer mode and the desktop workspaces. Spread into `SHORTCUT_CATALOG` after the Postbox, in this order,
 * which is the order their groups appear on the shortcuts page.
 *
 * The Team inbox thread, Workbench and peek entries are bound through the
 * app-wide dispatcher (`useKeyboardShortcuts`) by the surface that claims the
 * scope; the Team inbox list and the Updates page resolve theirs on the focused
 * list (`usePostboxListKeyboard`). Either way a remap moves them. Answer mode
 * and its queue cards live in `shortcutCatalogAnswer.ts`.
 */

import type { ShortcutDefinition } from './shortcutRegistry';
import { ANSWER_SHORTCUTS } from './shortcutCatalogAnswer';
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
		// Send, then the opposite of the "after replying" setting (keep / done).
		id: 'composer.sendAlternate',
		scope: 'composer',
		keys: ['mod+alt+Enter'],
		labelKey: L('sendAlternate'),
		groupKey: G.compose,
		...SURFACE,
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

	// --- Chat and Assistant message boxes (each answers its own keydown, and
	// only while the box is empty or holds a recalled question) ---------------
	{
		id: 'chatComposer.recallOlder',
		scope: 'chatComposer',
		keys: ['ArrowUp'],
		labelKey: L('recallLastMessage'),
		groupKey: G.compose,
		...SURFACE,
	},
	{
		id: 'chatComposer.recallNewer',
		scope: 'chatComposer',
		keys: ['ArrowDown'],
		labelKey: L('recallNewerQuestion'),
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
	{
		id: 'review.dismiss',
		scope: 'review',
		keys: ['d'],
		labelKey: L('dismissUpdate'),
		groupKey: G.review,
	},
	{
		id: 'review.requestReply',
		scope: 'review',
		keys: ['r'],
		labelKey: L('replyToUpdate'),
		groupKey: G.review,
	},

	// --- Team inbox list (the focused row of /dashboard/inbox). Its own scope,
	// so moving a row and assigning one can never share a key. -----------------
	{
		id: 'inboxList.next',
		scope: 'inboxList',
		keys: ['j', 'ArrowDown'],
		labelKey: L('next'),
		groupKey: G.teamInbox,
	},
	{
		id: 'inboxList.previous',
		scope: 'inboxList',
		keys: ['k', 'ArrowUp'],
		labelKey: L('previous'),
		groupKey: G.teamInbox,
	},
	{
		id: 'inboxList.open',
		scope: 'inboxList',
		keys: ['Enter'],
		labelKey: L('openThread'),
		groupKey: G.teamInbox,
		...CONVENTION,
	},
	{
		id: 'inboxList.assignToMe',
		scope: 'inboxList',
		keys: ['i'],
		labelKey: L('assignToMe'),
		groupKey: G.teamInbox,
	},
	// The triage verbs act on the selection when there is one, else on the
	// focused row.
	{
		id: 'inboxList.toggleSelect',
		scope: 'inboxList',
		keys: ['x'],
		labelKey: L('selectDeselect'),
		groupKey: G.teamInbox,
	},
	{
		id: 'inboxList.extendSelection',
		scope: 'inboxList',
		keys: ['J', 'K'],
		displayKeys: 'shift+j/k',
		labelKey: L('extendSelection'),
		groupKey: G.teamInbox,
		...SURFACE,
	},
	{
		id: 'inboxList.clearSelection',
		scope: 'inboxList',
		keys: ['Escape'],
		labelKey: L('clearSelection'),
		groupKey: G.teamInbox,
		...CONVENTION,
	},
	{
		id: 'inboxList.resolve',
		scope: 'inboxList',
		keys: ['e'],
		labelKey: L('resolveThread'),
		groupKey: G.teamInbox,
	},
	{
		id: 'inboxList.snooze',
		scope: 'inboxList',
		keys: ['h'],
		labelKey: L('snooze'),
		groupKey: G.teamInbox,
	},
	{
		id: 'inboxList.assign',
		scope: 'inboxList',
		keys: ['a'],
		labelKey: L('assignThread'),
		groupKey: G.teamInbox,
	},

	// --- Team inbox threads (claimed by the thread page) -----------------------
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

	...ANSWER_SHORTCUTS,

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
