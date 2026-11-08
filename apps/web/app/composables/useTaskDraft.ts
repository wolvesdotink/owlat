import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { TaskAudience, TaskCreateContext } from '~/types/tasks';
import {
	TASK_PRIVATE_AUDIENCE,
	taskAssigneeAfterAudience,
	taskAssigneeOptions,
	taskAudienceGroups,
} from '~/utils/taskAudience';
import { taskDueFromDateInput } from '~/utils/taskBuckets';

/**
 * A task being written: its title, audience, assignee and due date, and the
 * create call. Shared by the Tasks page's quick add and the "Make task"
 * popover, so both offer the same choices under the same rules.
 *
 * The assignee follows the audience: Only me pins it to the viewer, and a
 * group drops an assignee who is not in it.
 */
export function useTaskDraft(options: { initialAudience?: () => TaskAudience } = {}) {
	const { t } = useI18n();
	const people = useTaskPeople();

	const title = ref('');
	const audience = ref<TaskAudience>(options.initialAudience?.() ?? TASK_PRIVATE_AUDIENCE);
	const assigneeUserId = ref<string>(people.viewerId.value ?? '');
	const dueInput = ref('');

	watch(people.viewerId, (id) => {
		if (id && !assigneeUserId.value) assigneeUserId.value = id;
	});

	const groups = computed(() => taskAudienceGroups(people.groups.value, audience.value));
	const assigneeOptions = computed(() =>
		taskAssigneeOptions(
			audience.value,
			people.members.value,
			people.groups.value,
			people.viewerId.value
		)
	);
	const assigneeDisabledReason = computed(() =>
		audience.value.visibility === 'private' ? t('components.tasks.assignee.privateReason') : null
	);

	watch(
		[audience, () => people.members.value, () => people.groups.value],
		() => {
			const viewer = people.viewerId.value;
			if (!viewer) return;
			assigneeUserId.value = taskAssigneeAfterAudience(
				audience.value,
				assigneeUserId.value || viewer,
				people.members.value,
				people.groups.value,
				viewer
			);
		},
		{ deep: false }
	);

	const { run: runCreate, isLoading: isCreating } = useBackendOperation(
		api.tasks.mutations.create,
		{
			label: () => t('components.tasks.operations.create'),
		}
	);

	const canCreate = computed(() => title.value.trim().length > 0 && !isCreating.value);

	/** Creates the task; the new id, or null when nothing was created. */
	async function create(context: TaskCreateContext = {}): Promise<Id<'tasks'> | null> {
		const name = title.value.trim();
		if (!name || isCreating.value) return null;
		const viewer = people.viewerId.value;
		const assignee = assigneeUserId.value || viewer;
		const dueAt = taskDueFromDateInput(dueInput.value);
		const result = await runCreate({
			title: name,
			visibility: audience.value.visibility,
			...(audience.value.visibility === 'group' ? { groupId: audience.value.groupId } : {}),
			...(assignee && assignee !== viewer ? { assigneeUserId: assignee } : {}),
			...(dueAt !== null ? { dueAt } : {}),
			...(context.companyKey ? { companyKey: context.companyKey } : {}),
			...(context.mailThreadId ? { mailThreadId: context.mailThreadId } : {}),
			...(context.conversationThreadId
				? { conversationThreadId: context.conversationThreadId }
				: {}),
			...(context.threadItemId ? { threadItemId: context.threadItemId } : {}),
		});
		return result.ok ? result.result : null;
	}

	/** Clears the title and due date for the next task; audience and assignee stay. */
	function resetForNext() {
		title.value = '';
		dueInput.value = '';
	}

	return {
		people,
		title,
		audience,
		assigneeUserId,
		dueInput,
		groups,
		assigneeOptions,
		assigneeDisabledReason,
		canCreate,
		isCreating,
		create,
		resetForNext,
	};
}
