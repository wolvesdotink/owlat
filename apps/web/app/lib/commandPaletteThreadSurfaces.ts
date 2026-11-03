/**
 * Pure group builders for the OPEN CONVERSATION's palette verbs: the Postbox
 * reader's here, the Team Inbox thread page's in `commandPaletteTeamThreadSurfaces`
 * on the helpers this module exports.
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
import { senderZoomAtLimit, type SenderZoomAction } from '~/utils/senderZoom';
import {
	AlarmIcon,
	AlarmOffIcon,
	ArchiveIcon,
	BellIcon,
	BellOffIcon,
	ChatCircleIcon,
	ChatShareIcon,
	ClockIcon,
	CopyIcon,
	FileCodeIcon,
	FolderDownloadIcon,
	ForwardIcon,
	ImageIcon,
	InboxIcon,
	LinkIcon,
	MailIcon,
	PinIcon,
	PinOffIcon,
	ReplyIcon,
	SearchIcon,
	TagIcon,
	TranslateIcon,
	ZoomInIcon,
	ZoomOutIcon,
	type IconComponent,
} from '@coolicons/vue';

export type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * The unprefixed idle palette shows the first few verbs, beside the rest of the
 * palette; asked for (`>`) or narrowed by a typed word, all of them.
 */
const IDLE_CAP = 6;
const FULL_CAP = 20;

export function threadGroup(
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
export function withArgument(
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
	/** The caller's other mailboxes; empty leaves the verb out. */
	mailboxMoveOptions?: () => PaletteArgumentOption[];
	mailboxCopyOptions?: () => PaletteArgumentOption[];
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
	/** Opens "Share as image…" for the open message; absent where it cannot be drawn. */
	onShareAsImage?: () => void;
	onTranslate: () => void;
	onCopyLink: () => void;
	/** Chat is on: the conversation's link can be posted to a room. */
	canShareInChat: () => boolean;
	onShareInChat: () => void;
	/** Opens find in conversation; absent where the reader has none. */
	onFind?: () => void;
	/** The open message's sender zoom in percent; null when its From holds no address. */
	senderZoom: () => number | null;
	onZoom: (action: SenderZoomAction) => void;
	/** The chat layout's switch; absent where the thread has none (a team inbox). */
	chatView?: { isOn: () => boolean; toggle: () => void } | null;
}

const ZOOM_VERBS: ReadonlyArray<{ action: SenderZoomAction; slug: string; icon: IconComponent }> = [
	{ action: 'zoomIn', slug: 'zoom-in', icon: ZoomInIcon },
	{ action: 'zoomOut', slug: 'zoom-out', icon: ZoomOutIcon },
	{ action: 'zoomReset', slug: 'zoom-reset', icon: SearchIcon },
];

/** Zoom in, out and back to 100% for the open message's sender, each while it can move. */
function zoomItems(deps: ThreadSurfaceDeps): PaletteItem[] {
	const percent = deps.senderZoom();
	if (percent === null) return [];
	return ZOOM_VERBS.filter(({ action }) => !senderZoomAtLimit(percent, action)).map(
		({ action, slug, icon }) => ({
			id: `postbox:thread-${slug}`,
			label: deps.t(`${P}.${action}`, { percent }),
			icon,
			shortcutId: `postbox.${action}`,
			run: () => deps.onZoom(action),
		})
	);
}

const P = 'shared.commandPaletteSurfaces.thread';
/** "Copy link" / "Share in chat…" read the same in the ⋯ menus as here. */
const L = 'shared.conversationLink';

/** The two link verbs every open conversation offers, Postbox or Team Inbox. */
export function linkItems(
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
			icon: LinkIcon,
			run: deps.onCopyLink,
		},
	];
	if (deps.canShareInChat()) {
		items.push({
			id: `${idPrefix}-share-in-chat`,
			label: deps.t(`${L}.shareInChat`),
			icon: ChatShareIcon,
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
			icon: ReplyIcon,
			shortcutId: 'postbox.reply',
			run: deps.onReply,
		},
		{
			id: 'postbox:thread-archive',
			label: t(`${P}.archive`),
			...about,
			icon: ArchiveIcon,
			shortcutId: 'postbox.archive',
			run: deps.onArchive,
		},
		withArgument(
			{ id: 'postbox:thread-snooze', label: t(`${P}.snooze`), icon: ClockIcon },
			`${P}.snoozePrompt`,
			deps.snoozeOptions()
		),
		{
			id: 'postbox:forward',
			label: t(`${P}.forward`),
			icon: ForwardIcon,
			shortcutId: 'postbox.forward',
			run: deps.onForward,
		},
		{
			id: 'postbox:thread-mark-unread',
			label: t(`${P}.markUnread`),
			icon: MailIcon,
			shortcutId: 'postbox.markUnread',
			run: deps.onMarkUnread,
		},
		{
			id: 'postbox:thread-mute',
			label: t(deps.isMuted() ? `${P}.unmute` : `${P}.mute`),
			icon: deps.isMuted() ? BellIcon : BellOffIcon,
			shortcutId: 'postbox.mute',
			run: deps.onToggleMute,
		},
		{
			id: 'postbox:thread-alert',
			label: t(deps.isAlerted() ? `${P}.stopNotifyOnReply` : `${P}.notifyOnReply`),
			icon: BellIcon,
			run: deps.onToggleAlert,
		},
		{
			id: 'postbox:thread-pin',
			label: t(deps.isPinned() ? `${P}.unpin` : `${P}.pin`),
			icon: deps.isPinned() ? PinOffIcon : PinIcon,
			run: deps.onTogglePin,
		},
	];
	const labels = deps.labelOptions();
	if (labels.length > 0) {
		items.push(
			withArgument(
				{ id: 'postbox:label-as', label: t(`${P}.label`), icon: TagIcon },
				`${P}.labelPrompt`,
				labels
			)
		);
	}
	const folders = deps.folderOptions();
	if (folders.length > 0) {
		items.push(
			withArgument(
				{ id: 'postbox:move', label: t(`${P}.move`), icon: FolderDownloadIcon },
				`${P}.movePrompt`,
				folders
			)
		);
	}
	const mailboxMoves = deps.mailboxMoveOptions?.() ?? [];
	if (mailboxMoves.length > 0) {
		items.push(
			withArgument(
				{
					id: 'postbox:thread-move-to-mailbox',
					label: t(`${P}.moveToMailbox`),
					icon: InboxIcon,
				},
				`${P}.moveToMailboxPrompt`,
				mailboxMoves
			)
		);
	}
	const mailboxCopies = deps.mailboxCopyOptions?.() ?? [];
	if (mailboxCopies.length > 0) {
		items.push(
			withArgument(
				{
					id: 'postbox:thread-copy-to-mailbox',
					label: t(`${P}.copyToMailbox`),
					icon: CopyIcon,
				},
				`${P}.copyToMailboxPrompt`,
				mailboxCopies
			)
		);
	}
	const followUp = deps.followUp();
	if (followUp === 'armable') {
		items.push(
			withArgument(
				{ id: 'postbox:thread-follow-up', label: t(`${P}.followUp`), icon: AlarmIcon },
				`${P}.followUpPrompt`,
				deps.followUpOptions()
			)
		);
	} else if (followUp === 'armed') {
		items.push({
			id: 'postbox:thread-follow-up',
			label: t(`${P}.cancelFollowUp`),
			icon: AlarmOffIcon,
			run: deps.onCancelFollowUp,
		});
	}
	if (deps.onFind) {
		items.push({
			id: 'postbox:thread-find',
			label: t(`${P}.find`),
			...about,
			icon: SearchIcon,
			shortcutId: 'global.findInConversation',
			run: deps.onFind,
		});
	}
	items.push(...zoomItems(deps));
	if (deps.chatView) {
		items.push({
			id: 'postbox:thread-chat-view',
			label: t(deps.chatView.isOn() ? `${P}.showConversation` : `${P}.showChat`),
			...about,
			icon: ChatCircleIcon,
			shortcutId: 'postbox.chatView',
			run: deps.chatView.toggle,
		});
	}
	if (deps.canTranslate()) {
		items.push({
			id: 'postbox:thread-translate',
			label: t(`${P}.translate`),
			icon: TranslateIcon,
			run: deps.onTranslate,
		});
	}
	items.push(
		{
			id: 'postbox:thread-original',
			label: t(`${P}.showOriginal`),
			icon: FileCodeIcon,
			run: deps.onShowOriginal,
		},
		...linkItems('postbox:thread', deps)
	);
	if (deps.onShareAsImage) {
		items.push({
			id: 'postbox:thread-share-image',
			label: t('components.postbox.postboxShareImage.menuItem'),
			icon: ImageIcon,
			run: deps.onShareAsImage,
		});
	}
	return threadGroup(POSTBOX_THREAD_COMMAND_GROUP_KEY, t(`${P}.heading`), items, query, mode);
}

// ── Team Inbox thread ───────────────────────────────────────────────────────
