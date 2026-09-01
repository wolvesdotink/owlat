/**
 * THE keyboard vocabulary of the app — every chord the product answers, in one
 * list, with the i18n key of the sentence that describes it.
 *
 * Both cheat sheets (the app-wide one and the Postbox "?" overlay) are GENERATED
 * from this array, so a shortcut that is not documented here does not exist, and
 * one that is documented here cannot be quietly renamed out from under its help
 * text. Order is authored: groups appear in the order their first member does,
 * and within a group the most-used chord comes first.
 *
 * Scoping is what lets the Postbox reuse keys the rest of the app has already
 * spent. `g s` is "go to Admin" everywhere and "go to Starred" while the Postbox
 * owns the keyboard; `n` is "new item" on a list page and "next unread" in the
 * mailbox. `shortcutScope.ts` decides which chain is live.
 *
 * `remappable: false` marks the chords the remapping UI refuses to move —
 * platform conventions (Esc, ⌘Enter) and the handful whose handler still lives
 * outside the registry's dispatcher (⌘1–9 needs `event.code` to survive a
 * non-US layout, ⌘⇧F is matched leniently for browsers that drop the Shift).
 *
 * The named maps that DISAGREE with this list — Gmail's `b` for snooze, and the
 * user's own remaps — live next door in `shortcutPresets.ts`.
 */

import type { ShortcutDefinition } from './shortcutRegistry';

const G = {
	navigation: 'shared.shortcuts.groups.navigation',
	actions: 'shared.shortcuts.groups.actions',
	general: 'shared.shortcuts.groups.general',
	triage: 'shared.shortcuts.groups.triage',
	organize: 'shared.shortcuts.groups.organize',
	compose: 'shared.shortcuts.groups.compose',
	review: 'shared.shortcuts.groups.review',
	workspace: 'shared.shortcuts.groups.workspace',
} as const;

const L = (name: string) => `shared.shortcuts.labels.${name}`;

export const SHORTCUT_CATALOG: readonly ShortcutDefinition[] = [
	// --- App-wide navigation (the `g` chords) ---------------------------------
	{
		id: 'global.goToDashboard',
		scope: 'global',
		keys: ['g d'],
		labelKey: L('goToDashboard'),
		groupKey: G.navigation,
	},
	{
		id: 'global.goToContacts',
		scope: 'global',
		keys: ['g c'],
		labelKey: L('goToContacts'),
		groupKey: G.navigation,
	},
	{
		id: 'global.goToEmails',
		scope: 'global',
		keys: ['g e'],
		labelKey: L('goToEmails'),
		groupKey: G.navigation,
	},
	{
		id: 'global.goToCampaigns',
		scope: 'global',
		keys: ['g m'],
		labelKey: L('goToCampaigns'),
		groupKey: G.navigation,
	},
	{
		id: 'global.goToAutomations',
		scope: 'global',
		keys: ['g a'],
		labelKey: L('goToAutomations'),
		groupKey: G.navigation,
	},
	{
		id: 'global.goToTransactional',
		scope: 'global',
		keys: ['g t'],
		labelKey: L('goToTransactional'),
		groupKey: G.navigation,
	},
	{
		id: 'global.goToAdmin',
		scope: 'global',
		keys: ['g s'],
		labelKey: L('goToAdmin'),
		groupKey: G.navigation,
	},

	// --- App-wide actions -----------------------------------------------------
	{
		id: 'global.newItem',
		scope: 'global',
		keys: ['n'],
		labelKey: L('newItem'),
		groupKey: G.actions,
	},
	{
		// The quick-create registry's compose verb, one key from anywhere in the
		// app. `c` is free in every scope the catalog claims, and scope lookup is
		// what keeps it that way: a surface that later wants `c` for its own thing
		// binds it in ITS scope and wins the press without touching this line.
		id: 'global.compose',
		scope: 'global',
		keys: ['c'],
		labelKey: L('compose'),
		groupKey: G.actions,
	},
	{ id: 'global.save', scope: 'global', keys: ['s'], labelKey: L('save'), groupKey: G.actions },
	{
		id: 'global.commandPalette',
		scope: 'global',
		keys: ['mod+k'],
		labelKey: L('openSearch'),
		groupKey: G.actions,
		remappable: false,
	},
	{
		id: 'global.toggleSidebar',
		scope: 'global',
		keys: ['mod+\\'],
		labelKey: L('toggleSidebar'),
		groupKey: G.actions,
		remappable: false,
	},

	// --- App-wide general -----------------------------------------------------
	{
		id: 'global.help',
		scope: 'global',
		keys: ['?'],
		labelKey: L('showShortcuts'),
		groupKey: G.general,
	},
	{
		id: 'global.close',
		scope: 'global',
		keys: ['Escape'],
		labelKey: L('closeCancel'),
		groupKey: G.general,
		remappable: false,
	},

	// --- Postbox navigation ---------------------------------------------------
	{
		id: 'postbox.next',
		scope: 'postbox',
		keys: ['j', 'ArrowDown'],
		labelKey: L('nextMessage'),
		groupKey: G.navigation,
	},
	{
		id: 'postbox.previous',
		scope: 'postbox',
		keys: ['k', 'ArrowUp'],
		labelKey: L('previousMessage'),
		groupKey: G.navigation,
	},
	{
		id: 'postbox.nextUnread',
		scope: 'postbox',
		keys: ['n'],
		labelKey: L('nextUnread'),
		groupKey: G.navigation,
	},
	{
		id: 'postbox.previousUnread',
		scope: 'postbox',
		keys: ['p'],
		labelKey: L('previousUnread'),
		groupKey: G.navigation,
	},
	{
		id: 'postbox.open',
		scope: 'postbox',
		keys: ['Enter'],
		labelKey: L('openMessage'),
		groupKey: G.navigation,
		remappable: false,
	},
	{
		id: 'postbox.search',
		scope: 'postbox',
		keys: ['/'],
		labelKey: L('focusSearch'),
		groupKey: G.navigation,
	},
	{
		id: 'postbox.toggleBrowse',
		scope: 'postbox',
		keys: ['b'],
		labelKey: L('toggleTodayBrowse'),
		groupKey: G.navigation,
	},
	{
		id: 'postbox.goInbox',
		scope: 'postbox',
		keys: ['g i'],
		labelKey: L('goToInbox'),
		groupKey: G.navigation,
	},
	{
		id: 'postbox.goStarred',
		scope: 'postbox',
		keys: ['g s'],
		labelKey: L('goToStarred'),
		groupKey: G.navigation,
	},
	{
		id: 'postbox.goSent',
		scope: 'postbox',
		keys: ['g t'],
		labelKey: L('goToSent'),
		groupKey: G.navigation,
	},
	{
		id: 'postbox.goDrafts',
		scope: 'postbox',
		keys: ['g d'],
		labelKey: L('goToDrafts'),
		groupKey: G.navigation,
	},
	{
		id: 'postbox.close',
		scope: 'postbox',
		keys: ['Escape'],
		labelKey: L('closeConversation'),
		groupKey: G.navigation,
		remappable: false,
	},

	// --- Postbox triage -------------------------------------------------------
	{
		id: 'postbox.archive',
		scope: 'postbox',
		keys: ['e'],
		labelKey: L('archive'),
		groupKey: G.triage,
	},
	{
		id: 'postbox.trash',
		scope: 'postbox',
		keys: ['#', 'Delete', 'Backspace'],
		labelKey: L('moveToTrash'),
		groupKey: G.triage,
	},
	{
		id: 'postbox.star',
		scope: 'postbox',
		keys: ['s'],
		labelKey: L('starUnstar'),
		groupKey: G.triage,
	},
	{
		id: 'postbox.toggleRead',
		scope: 'postbox',
		keys: ['u'],
		labelKey: L('toggleRead'),
		groupKey: G.triage,
	},
	{
		id: 'postbox.markUnread',
		scope: 'postbox',
		keys: ['U'],
		labelKey: L('markUnread'),
		groupKey: G.triage,
	},
	{
		id: 'postbox.toggleSelect',
		scope: 'postbox',
		keys: ['x'],
		labelKey: L('selectDeselect'),
		groupKey: G.triage,
	},
	{
		id: 'postbox.extendSelection',
		scope: 'postbox',
		keys: ['J', 'K'],
		displayKeys: 'shift+j/k',
		labelKey: L('extendSelection'),
		groupKey: G.triage,
		remappable: false,
	},
	{
		id: 'postbox.undo',
		scope: 'postbox',
		keys: ['z'],
		labelKey: L('undoTriage'),
		groupKey: G.triage,
	},

	// --- Postbox organize -----------------------------------------------------
	{
		id: 'postbox.snooze',
		scope: 'postbox',
		keys: ['h'],
		labelKey: L('snooze'),
		groupKey: G.organize,
	},
	{
		id: 'postbox.mute',
		scope: 'postbox',
		keys: ['m'],
		labelKey: L('muteConversation'),
		groupKey: G.organize,
	},
	{
		id: 'postbox.label',
		scope: 'postbox',
		keys: ['l'],
		labelKey: L('addLabel'),
		groupKey: G.organize,
	},
	{
		id: 'postbox.move',
		scope: 'postbox',
		keys: ['v'],
		labelKey: L('moveToFolder'),
		groupKey: G.organize,
	},

	// --- Postbox compose ------------------------------------------------------
	{ id: 'postbox.reply', scope: 'postbox', keys: ['r'], labelKey: L('reply'), groupKey: G.compose },
	{
		id: 'postbox.replyAll',
		scope: 'postbox',
		keys: ['a'],
		labelKey: L('replyAll'),
		groupKey: G.compose,
	},
	{
		id: 'postbox.forward',
		scope: 'postbox',
		keys: ['f'],
		labelKey: L('forward'),
		groupKey: G.compose,
	},
	{
		id: 'postbox.help',
		scope: 'postbox',
		keys: ['?'],
		labelKey: L('toggleCheatSheet'),
		groupKey: G.general,
	},

	// --- Composer (bound on the composer root, not the window) ----------------
	{
		id: 'composer.send',
		scope: 'composer',
		keys: ['mod+Enter'],
		labelKey: L('send'),
		groupKey: G.compose,
		remappable: false,
	},
	{
		id: 'composer.schedule',
		scope: 'composer',
		keys: ['mod+shift+Enter'],
		labelKey: L('scheduleSend'),
		groupKey: G.compose,
		remappable: false,
	},
	{
		id: 'composer.focus',
		scope: 'composer',
		keys: ['mod+F'],
		displayKeys: 'mod+shift+F',
		labelKey: L('focusComposer'),
		groupKey: G.compose,
		remappable: false,
	},
	{
		id: 'composer.minimize',
		scope: 'composer',
		keys: ['Escape'],
		labelKey: L('minimizeComposer'),
		groupKey: G.compose,
		remappable: false,
	},

	// --- Review Queue ---------------------------------------------------------
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
		remappable: false,
	},
	{
		id: 'review.pickOption',
		scope: 'review',
		keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
		displayKeys: '1–9',
		labelKey: L('pickOption'),
		groupKey: G.review,
		remappable: false,
	},
	{
		id: 'review.approve',
		scope: 'review',
		keys: ['a'],
		labelKey: L('approveAndSend'),
		groupKey: G.review,
	},
	{ id: 'review.edit', scope: 'review', keys: ['e'], labelKey: L('edit'), groupKey: G.review },
	{ id: 'review.skip', scope: 'review', keys: ['s'], labelKey: L('skip'), groupKey: G.review },
	{ id: 'review.reject', scope: 'review', keys: ['#'], labelKey: L('reject'), groupKey: G.review },
	{
		id: 'review.toggleSelect',
		scope: 'review',
		keys: ['Space', 'x'],
		labelKey: L('select'),
		groupKey: G.review,
	},
	{
		id: 'review.extendSelection',
		scope: 'review',
		keys: ['J', 'K'],
		displayKeys: 'shift+j/k',
		labelKey: L('extendSelection'),
		groupKey: G.review,
		remappable: false,
	},
	{
		id: 'review.selectAll',
		scope: 'review',
		keys: ['*'],
		labelKey: L('selectAll'),
		groupKey: G.review,
	},

	// --- Desktop workspaces ---------------------------------------------------
	{
		id: 'workspace.switch',
		scope: 'workspace',
		keys: ['mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5', 'mod+6', 'mod+7', 'mod+8', 'mod+9'],
		displayKeys: 'mod+1–9',
		labelKey: L('switchWorkspace'),
		groupKey: G.workspace,
		remappable: false,
	},
];
