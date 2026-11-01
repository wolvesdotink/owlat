import type { PaletteArgumentOption } from '~/lib/commandPalette';
import { routePrefixMatcher } from '~/lib/commandPaletteRegistry';
import {
	TEAM_THREAD_COMMAND_PROVIDER_ID,
	TEAM_THREAD_COMMAND_PROVIDER_PRIORITY,
	buildTeamThreadSurfaceGroups,
} from '~/lib/commandPaletteThreadSurfaces';
import { usePostboxSnoozePresets } from '~/composables/postbox/usePostboxSnoozePresets';
import {
	TEAM_THREAD_PRIORITIES,
	TEAM_THREAD_PRIORITY_KEYS,
	type TeamThreadPriority,
} from '~/utils/teamThreadPriority';
import { UserCloseCornerIcon, UserIcon } from '@coolicons/vue';

/** What the Team Inbox thread page hands the palette. */
export interface TeamThreadCommandSources {
	subject: () => string;
	/** Admin or owner: every verb here writes the shared inbox, which only they may. */
	canAct: () => boolean;
	isMine: () => boolean;
	isResolved: () => boolean;
	isSnoozed: () => boolean;
	priority: () => TeamThreadPriority;
	assignedTo: () => string | null;
	members: () => ReadonlyArray<{ userId: string; name: string; email: string }>;
	onReply: () => void;
	onAssign: (userId: string | undefined) => void;
	onClaim: () => void;
	onStatus: (status: 'open' | 'resolved') => void;
	onSnooze: (until: number) => void;
	onSnoozeUntilReply: (capUntil: number) => void;
	onPickSnooze: () => void;
	onUnsnooze: () => void;
	onAddNote: () => void;
	onSetPriority: (priority: TeamThreadPriority) => void;
	onCopyLink: () => void;
	/** Chat is on: the thread's link can be posted to a room. */
	canShareInChat: () => boolean;
	onShareInChat: () => void;
}

/**
 * Registers the open Team Inbox conversation as a palette provider while its
 * page is mounted: reply, assign ›, assign to me, close / reopen, snooze › /
 * wake, add a note, priority ›, copy link, share in chat. Contributes nothing
 * to a member who cannot write the shared inbox — the page offers them none of
 * these either.
 */
export function useTeamThreadCommandSurface(sources: TeamThreadCommandSources): void {
	const { t } = useI18n();
	const { snoozeOptions } = usePostboxSnoozePresets();

	function assignOptions(): PaletteArgumentOption[] {
		const current = sources.assignedTo();
		const options: PaletteArgumentOption[] = sources.members().map((member) => ({
			id: `assign-${member.userId}`,
			label: member.name || member.email,
			...(member.userId === current
				? { subtitle: t('shared.commandPaletteSurfaces.teamThread.current') }
				: member.name
					? { subtitle: member.email }
					: {}),
			icon: UserIcon,
			run: () => sources.onAssign(member.userId),
		}));
		if (current) {
			options.push({
				id: 'assign-nobody',
				label: t('shared.commandPaletteSurfaces.teamThread.unassign'),
				icon: UserCloseCornerIcon,
				run: () => sources.onAssign(undefined),
			});
		}
		return options;
	}

	function priorityOptions(): PaletteArgumentOption[] {
		const current = sources.priority();
		return TEAM_THREAD_PRIORITIES.map((priority) => ({
			id: `priority-${priority}`,
			label: t(TEAM_THREAD_PRIORITY_KEYS[priority]),
			...(priority === current
				? { subtitle: t('shared.commandPaletteSurfaces.teamThread.current') }
				: {}),
			run: () => sources.onSetPriority(priority),
		}));
	}

	registerCommandPaletteProvider({
		id: TEAM_THREAD_COMMAND_PROVIDER_ID,
		priority: TEAM_THREAD_COMMAND_PROVIDER_PRIORITY,
		flag: 'inbox',
		matchRoute: routePrefixMatcher('/dashboard/inbox'),
		build: ({ query, mode }) => {
			if (!sources.canAct()) return [];
			return buildTeamThreadSurfaceGroups(
				{
					subject: sources.subject,
					t,
					isMine: sources.isMine,
					isResolved: sources.isResolved,
					isSnoozed: sources.isSnoozed,
					assignOptions,
					snoozeOptions: () =>
						snoozeOptions({
							hintText: sources.subject(),
							onSnooze: sources.onSnooze,
							onUntilReply: sources.onSnoozeUntilReply,
							onPickTime: sources.onPickSnooze,
						}),
					priorityOptions,
					onReply: sources.onReply,
					onClaim: sources.onClaim,
					onClose: () => sources.onStatus('resolved'),
					onReopen: () => sources.onStatus('open'),
					onUnsnooze: sources.onUnsnooze,
					onAddNote: sources.onAddNote,
					onCopyLink: sources.onCopyLink,
					canShareInChat: sources.canShareInChat,
					onShareInChat: sources.onShareInChat,
				},
				query,
				mode
			);
		},
	});
}
