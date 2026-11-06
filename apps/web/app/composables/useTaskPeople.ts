import { api } from '@owlat/api';
import type { TaskGroup, TaskMember } from '~/types/tasks';

/**
 * The people a task surface names: the workspace roster (for assignees and
 * "from <name>"), the member groups a task can be shown to, and the viewer.
 * Task rows carry BetterAuth user ids only; names and avatars come from the
 * shared organization roster.
 */
export function useTaskPeople() {
	const { t } = useI18n();
	const { user } = useAuth();
	const { members: roster, fetchMembers } = useOrganization();
	onMounted(() => {
		void fetchMembers();
	});

	const viewerId = computed(() => user.value?.id ?? null);

	const members = computed<TaskMember[]>(() =>
		roster.value.map((m) => ({
			userId: m.userId,
			name: m.user.name || null,
			email: m.user.email,
			image: m.user.image ?? null,
		}))
	);
	const byId = computed(() => new Map(members.value.map((m) => [m.userId, m])));

	const { data: groupData } = useConvexQuery(api.tasks.groups.list, {});
	const groups = computed<TaskGroup[]>(() => groupData.value ?? []);

	/** A member's display name; "someone" while the roster does not know them. */
	function nameOf(userId: string): string {
		const member = byId.value.get(userId);
		return member?.name?.trim() || member?.email || t('components.tasks.people.someone');
	}

	return { viewerId, members, byId, groups, nameOf };
}
