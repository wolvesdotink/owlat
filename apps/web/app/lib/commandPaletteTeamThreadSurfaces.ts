/**
 * Pure group builder for the Team Inbox thread page's palette verbs: the same
 * open-conversation contract as the Postbox reader's (see
 * `commandPaletteThreadSurfaces`), for a thread the team answers together.
 */
import {
	AlarmOffIcon,
	CircleCheckIcon,
	ClockIcon,
	FlagIcon,
	NoteIcon,
	ReplyIcon,
	RotateLeftIcon,
	UserPlusCornerIcon,
} from '@coolicons/vue';
import type {
	PaletteArgumentOption,
	PaletteGroup,
	PaletteItem,
	PaletteMode,
} from './commandPalette';
import {
	threadGroup,
	withArgument,
	linkItems,
	type Translate,
} from './commandPaletteThreadSurfaces';

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
			icon: ReplyIcon,
			run: deps.onReply,
		},
		withArgument(
			{ id: 'inbox:thread-assign', label: t(`${T}.assign`), icon: UserPlusCornerIcon },
			`${T}.assignPrompt`,
			deps.assignOptions()
		),
	];
	if (!deps.isMine()) {
		items.push({
			id: 'inbox:thread-claim',
			label: t(`${T}.claim`),
			icon: UserPlusCornerIcon,
			run: deps.onClaim,
		});
	}
	items.push(
		deps.isResolved()
			? {
					id: 'inbox:thread-status',
					label: t(`${T}.reopen`),
					icon: RotateLeftIcon,
					run: deps.onReopen,
				}
			: {
					id: 'inbox:thread-status',
					label: t(`${T}.close`),
					icon: CircleCheckIcon,
					run: deps.onClose,
				},
		deps.isSnoozed()
			? {
					id: 'inbox:thread-snooze',
					label: t(`${T}.unsnooze`),
					icon: AlarmOffIcon,
					run: deps.onUnsnooze,
				}
			: withArgument(
					{ id: 'inbox:thread-snooze', label: t(`${T}.snooze`), icon: ClockIcon },
					`${T}.snoozePrompt`,
					deps.snoozeOptions()
				),
		{
			id: 'inbox:thread-note',
			label: t(`${T}.addNote`),
			icon: NoteIcon,
			run: deps.onAddNote,
		},
		withArgument(
			{ id: 'inbox:thread-priority', label: t(`${T}.priority`), icon: FlagIcon },
			`${T}.priorityPrompt`,
			deps.priorityOptions()
		),
		...linkItems('inbox:thread', deps)
	);
	return threadGroup(TEAM_THREAD_COMMAND_GROUP_KEY, t(`${T}.heading`), items, query, mode);
}
