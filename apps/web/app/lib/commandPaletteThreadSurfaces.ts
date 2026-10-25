/**
 * Pure group builders for the OPEN CONVERSATION's palette verbs: the Postbox
 * reader's and the Team Inbox thread page's.
 *
 * Everything the toolbar, the ⋯ menu and the single-key shortcuts can do to the
 * conversation on screen is one ⌘K away, and a verb that needs a parameter (when
 * to snooze, which folder, whom to assign) is ONE row with a submenu rather than
 * a row per choice. The composables beside them
 * (`usePostboxThreadCommandSurface`, `useTeamThreadCommandSurface`) inject the
 * state, the translator, the submenu options and the `run` closures; the
 * composition — ids, order, which verb shows in which state — lives here so it
 * is testable without mounting a reader. Same split as `commandPaletteSurfaces`.
 *
 * Three Postbox ids are SHARED with the mailbox provider (`postbox:forward`,
 * `postbox:move`, `postbox:label-as`): this provider is consulted first, so while
 * a conversation is open its direct verb wins and the mailbox provider's
 * broadcast twin is dropped as a duplicate; with none open the twin remains.
 */
import {
	type PaletteArgumentOption,
	type PaletteGroup,
	type PaletteItem,
	type PaletteMode,
	filterItems,
} from './commandPalette';

type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * The unprefixed idle palette shows the first few verbs, beside the rest of the
 * palette; asked for (`>`) or narrowed by a typed word, all of them.
 */
const IDLE_CAP = 6;
const FULL_CAP = 20;

function threadGroup(
	key: string,
	heading: string,
	items: PaletteItem[],
	query: string,
	mode: PaletteMode
): PaletteGroup[] {
	return [
		{
			key,
			heading,
			// Above the core verbs (5) and the mailbox's own actions: what you can
			// do to the thing on screen comes first.
			order: 0,
			cap: query.trim() || mode === 'commands' ? FULL_CAP : IDLE_CAP,
			mode: 'commands',
			items: filterItems(items, query),
		},
	];
}

/** A verb that asks for its parameter first. `run` never fires for it. */
function withArgument(
	item: Omit<PaletteItem, 'run' | 'argument'>,
	promptKey: string,
	options: PaletteArgumentOption[]
): PaletteItem {
	return {
		...item,
		run: () => {},
		argument: { promptKey, headingKey: promptKey, icon: item.icon, options },
	};
}

// ── Postbox reader ──────────────────────────────────────────────────────────

/**
 * Registry id PREFIX of the thread provider. Two readers can be mounted at once
 * (the folder reader and the Today overlay), so each instance claims its own id
 * — first-claimant-wins would otherwise let the survivor of a pair be the one
 * whose registration was ignored, leaving the palette with no thread verbs at
 * all. Only the reader mounted last (the one on top) contributes.
 */
export const POSTBOX_THREAD_COMMAND_PROVIDER_ID_PREFIX = 'surface:postbox-thread';

/** Consulted before the Postbox layout's provider (15) within the external tier. */
export const POSTBOX_THREAD_COMMAND_PROVIDER_PRIORITY = 5;

/** Group key of the open-conversation block. */
export const POSTBOX_THREAD_COMMAND_GROUP_KEY = 'postbox-thread';

/** Where a "remind me if no reply" watch on the conversation stands. */
export type ThreadFollowUpState = 'armable' | 'armed' | 'none';

export interface ThreadSurfaceDeps {
	/** Subject of the open message, shown as the muted "what this acts on" line. */
	subject: () => string;
	t: Translate;
	isMuted: () => boolean;
	/** "Notify me when they reply" is armed. */
	isAlerted: () => boolean;
	/** The conversation is in the Inbox's pinned band. */
	isPinned: () => boolean;
	followUp: () => ThreadFollowUpState;
	/** Translation is offered (the AI flag is on). */
	canTranslate: () => boolean;
	/** Submenus, built by the composable (they carry their own `run`). */
	snoozeOptions: () => PaletteArgumentOption[];
	labelOptions: () => PaletteArgumentOption[];
	folderOptions: () => PaletteArgumentOption[];
	followUpOptions: () => PaletteArgumentOption[];
	onReply: () => void;
	onArchive: () => void;
	onForward: () => void;
	onMarkUnread: () => void;
	onToggleMute: () => void;
	onToggleAlert: () => void;
	onTogglePin: () => void;
	onCancelFollowUp: () => void;
	onShowOriginal: () => void;
	onTranslate: () => void;
	onCopyLink: () => void;
	/** Chat is on: the conversation's link can be posted to a room. */
	canShareInChat: () => boolean;
	onShareInChat: () => void;
	/** Opens find in conversation; absent where the reader has none. */
	onFind?: () => void;
}

const P = 'shared.commandPaletteSurfaces.thread';
/** "Copy link" / "Share in chat…" read the same in the ⋯ menus as here. */
const L = 'shared.conversationLink';

/** The two link verbs every open conversation offers, Postbox or Team Inbox. */
function linkItems(
	idPrefix: string,
	deps: {
		t: Translate;
		onCopyLink: () => void;
		canShareInChat: () => boolean;
		onShareInChat: () => void;
	}
): PaletteItem[] {
	const items: PaletteItem[] = [
		{
			id: `${idPrefix}-copy-link`,
			label: deps.t(`${L}.copyLink`),
			icon: 'lucide:link',
			run: deps.onCopyLink,
		},
	];
	if (deps.canShareInChat()) {
		items.push({
			id: `${idPrefix}-share-in-chat`,
			label: deps.t(`${L}.shareInChat`),
			icon: 'lucide:message-square-share',
			run: deps.onShareInChat,
		});
	}
	return items;
}

/**
 * Every verb for the open conversation: the toolbar's two, the ⋯ menu's, the
 * single-key triage verbs, and the rare ones (the original `.eml`, a translation,
 * a link to it). State-dependent verbs name the state they lead to ("Unmute",
 * "Cancel reply reminder"), and a verb with nothing to choose from is left out.
 * Pure.
 */
export function buildThreadSurfaceGroups(
	deps: ThreadSurfaceDeps,
	query: string,
	mode: PaletteMode = 'all'
): PaletteGroup[] {
	const { t } = deps;
	const subject = deps.subject().trim();
	const about = subject ? { subtitle: subject } : {};
	const items: PaletteItem[] = [
		{
			id: 'postbox:thread-reply',
			label: t(`${P}.reply`),
			...about,
			icon: 'lucide:reply',
			shortcutId: 'postbox.reply',
			run: deps.onReply,
		},
		{
			id: 'postbox:thread-archive',
			label: t(`${P}.archive`),
			...about,
			icon: 'lucide:archive',
			shortcutId: 'postbox.archive',
			run: deps.onArchive,
		},
		withArgument(
			{ id: 'postbox:thread-snooze', label: t(`${P}.snooze`), icon: 'lucide:clock' },
			`${P}.snoozePrompt`,
			deps.snoozeOptions()
		),
		{
			id: 'postbox:forward',
			label: t(`${P}.forward`),
			icon: 'lucide:forward',
			shortcutId: 'postbox.forward',
			run: deps.onForward,
		},
		{
			id: 'postbox:thread-mark-unread',
			label: t(`${P}.markUnread`),
			icon: 'lucide:mail',
			shortcutId: 'postbox.markUnread',
			run: deps.onMarkUnread,
		},
		{
			id: 'postbox:thread-mute',
			label: t(deps.isMuted() ? `${P}.unmute` : `${P}.mute`),
			icon: deps.isMuted() ? 'lucide:bell' : 'lucide:bell-off',
			shortcutId: 'postbox.mute',
			run: deps.onToggleMute,
		},
		{
			id: 'postbox:thread-alert',
			label: t(deps.isAlerted() ? `${P}.stopNotifyOnReply` : `${P}.notifyOnReply`),
			icon: 'lucide:bell',
			run: deps.onToggleAlert,
		},
		{
			id: 'postbox:thread-pin',
			label: t(deps.isPinned() ? `${P}.unpin` : `${P}.pin`),
			icon: deps.isPinned() ? 'lucide:pin-off' : 'lucide:pin',
			run: deps.onTogglePin,
		},
	];
	const labels = deps.labelOptions();
	if (labels.length > 0) {
		items.push(
			withArgument(
				{ id: 'postbox:label-as', label: t(`${P}.label`), icon: 'lucide:tag' },
				`${P}.labelPrompt`,
				labels
			)
		);
	}
	const folders = deps.folderOptions();
	if (folders.length > 0) {
		items.push(
			withArgument(
				{ id: 'postbox:move', label: t(`${P}.move`), icon: 'lucide:folder-input' },
				`${P}.movePrompt`,
				folders
			)
		);
	}
	const followUp = deps.followUp();
	if (followUp === 'armable') {
		items.push(
			withArgument(
				{ id: 'postbox:thread-follow-up', label: t(`${P}.followUp`), icon: 'lucide:alarm-clock' },
				`${P}.followUpPrompt`,
				deps.followUpOptions()
			)
		);
	} else if (followUp === 'armed') {
		items.push({
			id: 'postbox:thread-follow-up',
			label: t(`${P}.cancelFollowUp`),
			icon: 'lucide:alarm-clock-off',
			run: deps.onCancelFollowUp,
		});
	}
	if (deps.onFind) {
		items.push({
			id: 'postbox:thread-find',
			label: t(`${P}.find`),
			...about,
			icon: 'lucide:search',
			shortcutId: 'global.findInConversation',
			run: deps.onFind,
		});
	}
	if (deps.canTranslate()) {
		items.push({
			id: 'postbox:thread-translate',
			label: t(`${P}.translate`),
			icon: 'lucide:languages',
			run: deps.onTranslate,
		});
	}
	items.push(
		{
			id: 'postbox:thread-original',
			label: t(`${P}.showOriginal`),
			icon: 'lucide:file-code',
			run: deps.onShowOriginal,
		},
		...linkItems('postbox:thread', deps)
	);
	return threadGroup(POSTBOX_THREAD_COMMAND_GROUP_KEY, t(`${P}.heading`), items, query, mode);
}

// ── Team Inbox thread ───────────────────────────────────────────────────────

/** Registry id of the Team Inbox thread provider (one thread page at a time). */
export const TEAM_THREAD_COMMAND_PROVIDER_ID = 'surface:team-thread';

/** Consulted before the other external providers: the thread is what is on screen. */
export const TEAM_THREAD_COMMAND_PROVIDER_PRIORITY = 5;

/** Group key of the Team Inbox conversation block. */
export const TEAM_THREAD_COMMAND_GROUP_KEY = 'team-thread';

export interface TeamThreadSurfaceDeps {
	subject: () => string;
	t: Translate;
	/** The thread is assigned to the person at the keyboard. */
	isMine: () => boolean;
	/** Resolved (or legacy closed): the status verb reopens instead. */
	isResolved: () => boolean;
	isSnoozed: () => boolean;
	/** Submenus, built by the composable (they carry their own `run`). */
	assignOptions: () => PaletteArgumentOption[];
	snoozeOptions: () => PaletteArgumentOption[];
	priorityOptions: () => PaletteArgumentOption[];
	onReply: () => void;
	onClaim: () => void;
	onClose: () => void;
	onReopen: () => void;
	onUnsnooze: () => void;
	onAddNote: () => void;
	onCopyLink: () => void;
	canShareInChat: () => boolean;
	onShareInChat: () => void;
}

const T = 'shared.commandPaletteSurfaces.teamThread';

/**
 * The Team Inbox conversation's verbs: reply, assign / claim, close or reopen,
 * snooze or wake, an internal note, its priority, and a link to it. Pure.
 */
export function buildTeamThreadSurfaceGroups(
	deps: TeamThreadSurfaceDeps,
	query: string,
	mode: PaletteMode = 'all'
): PaletteGroup[] {
	const { t } = deps;
	const subject = deps.subject().trim();
	const items: PaletteItem[] = [
		{
			id: 'inbox:thread-reply',
			label: t(`${T}.reply`),
			...(subject ? { subtitle: subject } : {}),
			icon: 'lucide:reply',
			run: deps.onReply,
		},
		withArgument(
			{ id: 'inbox:thread-assign', label: t(`${T}.assign`), icon: 'lucide:user-plus' },
			`${T}.assignPrompt`,
			deps.assignOptions()
		),
	];
	if (!deps.isMine()) {
		items.push({
			id: 'inbox:thread-claim',
			label: t(`${T}.claim`),
			icon: 'lucide:user-plus',
			run: deps.onClaim,
		});
	}
	items.push(
		deps.isResolved()
			? {
					id: 'inbox:thread-status',
					label: t(`${T}.reopen`),
					icon: 'lucide:rotate-ccw',
					run: deps.onReopen,
				}
			: {
					id: 'inbox:thread-status',
					label: t(`${T}.close`),
					icon: 'lucide:circle-check',
					run: deps.onClose,
				},
		deps.isSnoozed()
			? {
					id: 'inbox:thread-snooze',
					label: t(`${T}.unsnooze`),
					icon: 'lucide:alarm-clock-off',
					run: deps.onUnsnooze,
				}
			: withArgument(
					{ id: 'inbox:thread-snooze', label: t(`${T}.snooze`), icon: 'lucide:clock' },
					`${T}.snoozePrompt`,
					deps.snoozeOptions()
				),
		{
			id: 'inbox:thread-note',
			label: t(`${T}.addNote`),
			icon: 'lucide:sticky-note',
			run: deps.onAddNote,
		},
		withArgument(
			{ id: 'inbox:thread-priority', label: t(`${T}.priority`), icon: 'lucide:flag' },
			`${T}.priorityPrompt`,
			deps.priorityOptions()
		),
		...linkItems('inbox:thread', deps)
	);
	return threadGroup(TEAM_THREAD_COMMAND_GROUP_KEY, t(`${T}.heading`), items, query, mode);
}
