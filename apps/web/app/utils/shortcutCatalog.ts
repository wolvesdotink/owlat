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
 * `remappable: false` marks the chords the remapping UI refuses to move, each
 * with its reason (`CONVENTION`, `LAYOUT`, `SURFACE` in `shortcutCatalogParts`):
 * platform conventions (Esc, ⌘Enter), keys matched by position (⌘1–9 and
 * Alt+1–9 read `event.code` to survive a non-US layout) and the handful whose
 * handler still lives outside the registry's dispatcher (⌘⇧F is matched
 * leniently for browsers that drop the Shift). Every other key a surface
 * answers is listed here too, so the shortcuts page can show all of them.
 *
 * The named maps that DISAGREE with this list — Gmail's `b` for snooze, and the
 * user's own remaps — live next door in `shortcutPresets.ts`.
 */

import type { ShortcutDefinition } from './shortcutRegistry';
import {
	FIXED_CONVENTION as CONVENTION,
	FIXED_LAYOUT as LAYOUT,
	FIXED_SURFACE as SURFACE,
	SHORTCUT_GROUPS as G,
	shortcutLabelKey as L,
} from './shortcutCatalogParts';
import { SENDER_SHORTCUTS } from './shortcutCatalogSenders';
import { SURFACE_SHORTCUTS } from './shortcutCatalogSurfaces';

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
		id: 'global.goToAnswer',
		scope: 'global',
		keys: ['g q'],
		labelKey: L('goToAnswer'),
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
		labelKey: L('goToMarketing'),
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
		...CONVENTION,
	},
	{
		// The dashboard layout binds these three through the dispatcher, which
		// lets them fire while a text field has focus, as modifier chords may.
		id: 'global.toggleSidebar',
		scope: 'global',
		keys: ['mod+\\'],
		labelKey: L('toggleSidebar'),
		groupKey: G.actions,
	},
	{
		id: 'global.settings',
		scope: 'global',
		keys: ['mod+,'],
		labelKey: L('openSettings'),
		groupKey: G.actions,
	},
	{
		// Inside Answer mode the same chord drafts with AI (`answer.draftWithAi`).
		id: 'global.assistant',
		scope: 'global',
		keys: ['mod+j'],
		labelKey: L('openAssistant'),
		groupKey: G.actions,
	},
	{
		// The same chord the email builder has always used for its focus mode;
		// handled by ShellZenExit, outside the dispatcher.
		id: 'global.zen',
		scope: 'global',
		keys: ['mod+shift+F'],
		labelKey: L('zenMode'),
		groupKey: G.actions,
		...SURFACE,
	},
	{
		// useSidebarJumpHints: hold Alt to see the numbers.
		id: 'global.jumpToSidebarItem',
		scope: 'global',
		keys: ['alt+1', 'alt+2', 'alt+3', 'alt+4', 'alt+5', 'alt+6', 'alt+7', 'alt+8', 'alt+9'],
		displayKeys: 'alt+1–9',
		labelKey: L('jumpToSidebarItem'),
		groupKey: G.actions,
		...LAYOUT,
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
		...CONVENTION,
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
		...CONVENTION,
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
		// usePostboxInboxModes: works from anywhere in the inbox, unlike `b`.
		id: 'postbox.toggleBrowseChord',
		scope: 'postbox',
		keys: ['mod+b'],
		labelKey: L('toggleTodayBrowse'),
		groupKey: G.navigation,
		...SURFACE,
	},
	{
		// PostboxFolderRail: works whatever has focus.
		id: 'postbox.toggleRail',
		scope: 'postbox',
		keys: ['mod+shift+D'],
		labelKey: L('toggleFolderRail'),
		groupKey: G.navigation,
		...SURFACE,
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
		...CONVENTION,
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
	...SENDER_SHORTCUTS,
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
		...SURFACE,
	},
	{
		id: 'postbox.undo',
		scope: 'postbox',
		keys: ['z'],
		labelKey: L('undoTriage'),
		groupKey: G.triage,
	},
	{
		// usePostboxTriageUndo: the toast's own undo, inert while typing.
		id: 'postbox.undoChord',
		scope: 'postbox',
		keys: ['mod+z'],
		labelKey: L('undoTriage'),
		groupKey: G.triage,
		...CONVENTION,
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
	...SURFACE_SHORTCUTS,
];
