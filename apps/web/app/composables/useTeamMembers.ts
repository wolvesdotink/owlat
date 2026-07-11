import type { ComputedRef, Ref } from 'vue';
import { api } from '@owlat/api';
import type { OrganizationMember } from '~/composables/useOrganization';
import { mailboxStatusMeta, type MailboxStatusMeta } from '~/utils/teamRoles';

/**
 * Roster-presentation concerns for the Team Management page: the name/email
 * search filter and each member's hosted/external/none mailbox status. Kept out
 * of the page SFC so the invite flow and the table stay independently readable.
 *
 * `members` is the shared `useState`-backed roster from `useOrganization()`;
 * pass it in rather than re-reading it so this composable stays a pure view over
 * whatever roster the caller already holds.
 */
export function useTeamMembers(
	members: Ref<OrganizationMember[]> | ComputedRef<OrganizationMember[]>
) {
	// Search box above the members table. Filters by name or email, case-insensitive.
	const memberSearch = ref('');
	const filteredMembers = computed(() => {
		const q = memberSearch.value.trim().toLowerCase();
		if (!q) return members.value;
		return members.value.filter(
			(m) => m.user.name.toLowerCase().includes(q) || m.user.email.toLowerCase().includes(q)
		);
	});

	// Per-member mailbox status (hosted / external / none) for the Mailbox column.
	// Keyed by BetterAuth user id; absent ⇒ no mailbox. Any org member may read it.
	const memberUserIds = computed(() => members.value.map((m) => m.userId));
	const { data: mailboxStatusData, isLoading: isLoadingMailboxStatus } = useConvexQuery(
		api.mail.memberMailboxStatus.byMembers,
		() => ({
			userIds: memberUserIds.value,
		})
	);

	// While the status query is still resolving we don't yet know if a member has a
	// mailbox — render a neutral placeholder instead of a definitive "No mailbox".
	const isMailboxStatusPending = computed(
		() => isLoadingMailboxStatus.value && mailboxStatusData.value === undefined
	);

	// Precompute the presentable Mailbox cell once per member so the four reads a
	// row needs (tone/icon/label/description) don't each re-run the mapping.
	const mailboxMetaByUserId = computed<Record<string, MailboxStatusMeta>>(() => {
		const map: Record<string, MailboxStatusMeta> = {};
		for (const member of members.value) {
			map[member.userId] = mailboxStatusMeta(mailboxStatusData.value?.[member.userId] ?? 'none');
		}
		return map;
	});

	function mailboxMetaFor(userId: string): MailboxStatusMeta {
		return mailboxMetaByUserId.value[userId] ?? mailboxStatusMeta('none');
	}

	return {
		memberSearch,
		filteredMembers,
		isMailboxStatusPending,
		mailboxMetaFor,
	};
}
