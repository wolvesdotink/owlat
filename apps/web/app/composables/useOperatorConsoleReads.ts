import { api } from '@owlat/api';
import type { Ref } from 'vue';
import { operatorConsoleLayout, type OperatorTab } from '~/utils/operatorConsole';

/**
 * The operator console's reads, the layout the workspace count decides, and
 * whether the reads behind the active tab have answered. All reads are
 * `requirePlatformAdmin`-gated and take no organization argument.
 */
export function useOperatorConsoleReads(activeTab: Readonly<Ref<OperatorTab>>) {
	const statsQuery = useConvexQuery(api.platformAdmin.queries.getPlatformStats, () => ({}));
	const abuseQuery = useConvexQuery(api.platformAdmin.queries.listRecentAbuse, () => ({}));
	const reviewQuery = useConvexQuery(api.platformAdmin.queries.getContentReviewQueue, () => ({}));
	const flaggedQuery = useConvexQuery(
		api.platformAdmin.queries.listFlaggedOrganizations,
		() => ({})
	);
	const orgsQuery = useConvexQuery(api.platformAdmin.queries.listAllOrganizations, () => ({}));
	const orgDetailQuery = useConvexQuery(
		api.platformAdmin.queries.getOrganizationDetail,
		() => ({})
	);
	const adminsQuery = useConvexQuery(api.platformAdmin.queries.listPlatformAdmins, () => ({}));
	const usersQuery = useConvexQuery(api.platformAdmin.queries.listAllUsers, () => ({}));

	const deploymentMode = useRuntimeConfig().public.deploymentMode as string | undefined;
	const layout = computed(() =>
		operatorConsoleLayout(deploymentMode, orgsQuery.data.value?.length)
	);

	// The reads behind each tab. A failed one shows the error and Try again in
	// place of the tab, never its "nothing here" state.
	const tabReads = computed(
		() =>
			({
				// The sending-status card reads the settings detail; until it answers
				// the card would show a clean status.
				overview: layout.value.showSendingStatusOnOverview
					? [statsQuery, abuseQuery, orgDetailQuery]
					: [statsQuery, abuseQuery],
				review: [reviewQuery],
				organizations: [flaggedQuery, orgsQuery, orgDetailQuery],
				admins: [adminsQuery, usersQuery],
			})[activeTab.value]
	);
	const tabError = computed(() => tabReads.value.find((q) => q.error.value)?.error.value ?? null);
	// Until every read behind the tab has answered, the tab would claim "nothing to
	// review", a clean status or an empty roster, which on a moderation console
	// reads as an all-clear.
	const tabLoading = computed(() => tabReads.value.some((q) => q.data.value === undefined));
	function retryTab() {
		for (const q of tabReads.value) if (q.error.value) q.refetch();
	}

	return {
		stats: statsQuery.data,
		recentAbuse: abuseQuery.data,
		reviewQueue: reviewQuery.data,
		flaggedOrgs: flaggedQuery.data,
		allOrgs: orgsQuery.data,
		orgDetail: orgDetailQuery.data,
		admins: adminsQuery.data,
		allUsers: usersQuery.data,
		layout,
		tabError,
		tabLoading,
		retryTab,
	};
}
