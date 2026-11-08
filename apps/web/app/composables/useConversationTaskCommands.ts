import { shallowRef } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { filterItems, type PaletteGroup, type PaletteItem } from '~/lib/commandPalette';
import { routePrefixMatcher } from '~/lib/commandPaletteRegistry';
import { CheckIcon, ListChecklistIcon, ListUnorderedIcon } from '@coolicons/vue';

/** Registry id prefix; each mounted purpose header registers its own. */
export const CONVERSATION_TASK_COMMAND_PROVIDER_ID_PREFIX = 'surface:conversation-tasks';

/** Right after the open conversation's own verbs (priority 5). */
export const CONVERSATION_TASK_COMMAND_PROVIDER_PRIORITY = 6;

export const CONVERSATION_TASK_COMMAND_GROUP_KEY = 'conversation-tasks';

const matchPostbox = routePrefixMatcher('/dashboard/postbox');
const matchTeamInbox = routePrefixMatcher('/dashboard/inbox');

/** The Postbox reader's routes and the Team Inbox thread page, where a purpose header opens. */
export function matchConversationRoute(path: string): boolean {
	return matchPostbox(path) || matchTeamInbox(path);
}

/** What the open conversation's purpose header hands the palette. */
export interface ConversationTaskCommandSources {
	/** What Make task ties the task to; without either there is no conversation. */
	mailThreadId: () => Id<'mailThreads'> | undefined;
	conversationThreadId: () => Id<'conversationThreads'> | undefined;
	/** The top item's words while the header offers Done on it, else null. */
	doneItem: () => string | null;
	/** Opens the header's own Make task popover. */
	openMakeTask: () => void;
	/** The header's Done on the top item. */
	markDone: () => void;
}

/**
 * The mounted purpose headers, oldest first. The Today overlay opens a
 * conversation over the folder reader's, and only the one on top may answer:
 * a verb acts on the conversation in front of the person.
 */
const mountedHeaders = shallowRef<readonly string[]>([]);

/**
 * Registers the open conversation's task verbs with the command palette while
 * its purpose header is mounted: Make task from this conversation, Done on
 * the top item (only while the header offers it), and Open tasks from this
 * conversation (only while there are some). They run the header's own
 * actions, so the palette and the header can never disagree.
 */
export function useConversationTaskCommands(sources: ConversationTaskCommandSources): void {
	const { t } = useI18n();
	const instanceId = useId();

	onMounted(() => {
		mountedHeaders.value = [...mountedHeaders.value, instanceId];
	});
	onBeforeUnmount(() => {
		mountedHeaders.value = mountedHeaders.value.filter((id) => id !== instanceId);
	});
	const isTopmost = () => mountedHeaders.value[mountedHeaders.value.length - 1] === instanceId;

	const args = () => {
		const mailThreadId = sources.mailThreadId();
		if (mailThreadId) return { mailThreadId };
		const conversationThreadId = sources.conversationThreadId();
		if (conversationThreadId) return { conversationThreadId };
		return 'skip' as const;
	};
	// The same query the company panel beside the conversation reads, so one subscription.
	const tasksQuery = useConvexQuery(api.tasks.tasks.forThread, args);
	const openTasks = computed(() =>
		(tasksQuery.data.value ?? []).filter((task) => task.status === 'open')
	);

	function items(): PaletteItem[] {
		const list: PaletteItem[] = [
			{
				id: 'conversation:make-task',
				label: t('shared.commandPaletteSurfaces.conversationTasks.makeTask'),
				icon: ListChecklistIcon,
				// After the palette has closed and handed focus back: the popover
				// closes again when focus lands outside it.
				run: () => void setTimeout(sources.openMakeTask, 0),
			},
		];
		const doneItem = sources.doneItem();
		if (doneItem) {
			list.push({
				id: 'conversation:mark-done',
				label: t('shared.commandPaletteSurfaces.conversationTasks.markDone', { item: doneItem }),
				icon: CheckIcon,
				run: sources.markDone,
			});
		}
		const first = openTasks.value[0];
		if (first) {
			const count = openTasks.value.length;
			list.push({
				id: 'conversation:open-tasks',
				label: t('shared.commandPaletteSurfaces.conversationTasks.openTasks'),
				subtitle: t('shared.commandPaletteSurfaces.conversationTasks.openCount', { count }, count),
				icon: ListUnorderedIcon,
				run: () => void navigateTo(`/dashboard/tasks?task=${first._id}`),
			});
		}
		return list;
	}

	registerCommandPaletteProvider({
		id: `${CONVERSATION_TASK_COMMAND_PROVIDER_ID_PREFIX}:${instanceId}`,
		priority: CONVERSATION_TASK_COMMAND_PROVIDER_PRIORITY,
		matchRoute: matchConversationRoute,
		build: ({ query }): PaletteGroup[] => {
			if (!isTopmost() || args() === 'skip') return [];
			return [
				{
					key: CONVERSATION_TASK_COMMAND_GROUP_KEY,
					heading: t('shared.commandPaletteSurfaces.conversationTasks.heading'),
					// Just under the conversation's own verbs (0).
					order: 1,
					mode: 'commands',
					items: filterItems(items(), query),
				},
			];
		},
	});
}
