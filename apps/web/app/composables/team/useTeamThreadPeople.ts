import { computed, onMounted, ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { useOrganization } from '~/composables/useOrganization';

/**
 * The people around a Team Inbox thread: the org members its assignee picker
 * offers, the assignee's display name, and who else has the thread open.
 */
export function useTeamThreadPeople(options: {
	threadId: Ref<Id<'conversationThreads'>>;
	assignedTo: () => string | undefined;
}) {
	const { t } = useI18n();

	// Org members for the assignee picker (shared-inbox team triage).
	const { members, fetchMembers } = useOrganization();
	onMounted(() => {
		void fetchMembers();
	});

	// Members projected for the avatar picker.
	const assignMembers = computed(() =>
		members.value.map((m) => ({
			userId: m.userId,
			name: m.user.name,
			email: m.user.email,
			image: m.user.image,
		}))
	);

	const assignedMemberName = computed(() => {
		const id = options.assignedTo();
		if (!id) return null;
		const m = members.value.find((x) => x.userId === id);
		return m ? m.user.name || m.user.email : id;
	});

	// Live thread presence — heartbeat while this thread is open (the reply is
	// written in Answer mode, which reports "replying" itself). `others` excludes
	// the current user; resolve each to a display name/avatar via the
	// already-fetched org members.
	const { others: presenceOthers } = useThreadPresence(options.threadId, { replying: ref(false) });
	const presencePeople = computed(() =>
		presenceOthers.value.map((p) => {
			const m = members.value.find((x) => x.userId === p.userId);
			return {
				userId: p.userId,
				mode: p.mode,
				name: m ? m.user.name || m.user.email : t('dashboard.inbox.detail.someone'),
				image: m?.user.image ?? null,
			};
		})
	);

	return { assignMembers, assignedMemberName, presencePeople };
}
