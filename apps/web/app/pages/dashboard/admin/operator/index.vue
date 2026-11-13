<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { tabPanelAttrs } from '@owlat/ui/utils/tabs';
import OperatorAdminsTab from '~/components/operator/AdminsTab.vue';
import OperatorOrganizationsTab from '~/components/operator/OrganizationsTab.vue';
import OperatorOverviewTab from '~/components/operator/OverviewTab.vue';
import OperatorReviewTab from '~/components/operator/ReviewTab.vue';
import {
	isBlockingAbuseStatus,
	operatorConsoleLayout,
	type OperatorReviewItem,
} from '~/utils/operatorConsole';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.operator.index.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'platform-admin'],
});

const { showToast } = useToast();

// ── Tabs ──────────────────────────────────────────────────────────────────────
type TabValue = 'overview' | 'review' | 'organizations' | 'admins';
const activeTab = ref<TabValue>('overview');
const tabPanelId = useId();

// ── Queries (all requirePlatformAdmin-gated; no org arg needed) ───────────────
const statsQuery = useConvexQuery(api.platformAdmin.queries.getPlatformStats, () => ({}));
const abuseQuery = useConvexQuery(api.platformAdmin.queries.listRecentAbuse, () => ({}));
const reviewQuery = useConvexQuery(api.platformAdmin.queries.getContentReviewQueue, () => ({}));
const flaggedQuery = useConvexQuery(api.platformAdmin.queries.listFlaggedOrganizations, () => ({}));
const orgsQuery = useConvexQuery(api.platformAdmin.queries.listAllOrganizations, () => ({}));
const { data: orgDetail } = useConvexQuery(
	api.platformAdmin.queries.getOrganizationDetail,
	() => ({})
);
const adminsQuery = useConvexQuery(api.platformAdmin.queries.listPlatformAdmins, () => ({}));
const usersQuery = useConvexQuery(api.platformAdmin.queries.listAllUsers, () => ({}));
const stats = statsQuery.data;
const recentAbuse = abuseQuery.data;
const reviewQueue = reviewQuery.data;
const flaggedOrgs = flaggedQuery.data;
const allOrgs = orgsQuery.data;
const admins = adminsQuery.data;
const allUsers = usersQuery.data;

// The reads behind each tab. A failed one shows the error and Try again in
// place of the tab, never its "nothing here" state.
const tabReads = computed(
	() =>
		({
			overview: [statsQuery, abuseQuery],
			review: [reviewQuery],
			organizations: [flaggedQuery, orgsQuery],
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

const deploymentMode = useRuntimeConfig().public.deploymentMode as string | undefined;
const layout = computed(() => operatorConsoleLayout(deploymentMode, allOrgs.value?.length));

const allTabs = computed(() => [
	{ value: 'overview', label: t('dashboard.admin.operator.index.tabs.overview') },
	{
		value: 'review',
		label: t('dashboard.admin.operator.index.tabs.review'),
		count: reviewQueue.value?.pendingCount,
	},
	{
		value: 'organizations',
		label: t('dashboard.admin.operator.index.tabs.organizations'),
		count: flaggedOrgs.value?.length,
	},
	{
		value: 'admins',
		label: t('dashboard.admin.operator.index.tabs.admins'),
		count: admins.value?.length,
	},
]);
const tabs = computed(() =>
	allTabs.value.filter((tab) => layout.value.tabs.includes(tab.value as TabValue))
);
// A trimmed console never strands the reader on a tab it no longer shows.
watch(layout, ({ tabs: shown }) => {
	if (!shown.includes(activeTab.value)) activeTab.value = 'overview';
});

// ── Mutations ─────────────────────────────────────────────────────────────────
const { run: approveCampaign, isLoading: approvingCampaign } = useBackendOperation(
	api.platformAdmin.mutations.approveCampaign,
	{ label: () => t('dashboard.admin.operator.index.operations.approveCampaign') }
);
const { run: approveTransactional, isLoading: approvingTransactional } = useBackendOperation(
	api.platformAdmin.mutations.approveTransactional,
	{ label: () => t('dashboard.admin.operator.index.operations.approveTransactional') }
);
const { run: rejectContent, isLoading: rejecting } = useBackendOperation(
	api.platformAdmin.mutations.rejectContent,
	{ label: () => t('dashboard.admin.operator.index.operations.rejectContent') }
);
const { run: setOrganizationStatus, isLoading: settingStatus } = useBackendOperation(
	api.platformAdmin.mutations.setOrganizationStatus,
	{ label: () => t('dashboard.admin.operator.index.operations.setStatus') }
);
const { run: addPlatformAdmin, isLoading: addingAdmin } = useBackendOperation(
	api.platformAdmin.mutations.addPlatformAdmin,
	{ label: () => t('dashboard.admin.operator.index.operations.addAdmin') }
);
const { run: removePlatformAdmin, isLoading: removingAdmin } = useBackendOperation(
	api.platformAdmin.mutations.removePlatformAdmin,
	{ label: () => t('dashboard.admin.operator.index.operations.removeAdmin') }
);

// ── Content review actions ────────────────────────────────────────────────────
// The row whose approval is in flight, so only its button spins.
const approvingKey = ref<string | null>(null);

async function onApprove(item: OperatorReviewItem) {
	approvingKey.value = `${item.type}-${item.id}`;
	try {
		await approveItem(item);
	} finally {
		approvingKey.value = null;
	}
}

async function approveItem(item: OperatorReviewItem) {
	if (item.type === 'campaign') {
		const r = await approveCampaign({ campaignId: item.id as Id<'campaigns'> });
		if (r.ok)
			showToast(
				t('dashboard.admin.operator.index.toasts.approvedCampaign', {
					name: item.name ?? t('dashboard.admin.operator.index.fallbackNames.campaign'),
				})
			);
	} else {
		const r = await approveTransactional({
			transactionalEmailId: item.id as Id<'transactionalEmails'>,
		});
		if (r.ok)
			showToast(
				t('dashboard.admin.operator.index.toasts.approvedTransactional', {
					name: item.name ?? t('dashboard.admin.operator.index.fallbackNames.email'),
				})
			);
	}
}

const rejectModalOpen = ref(false);
const rejectTarget = ref<OperatorReviewItem | null>(null);
const rejectReason = ref('');

function openReject(item: OperatorReviewItem) {
	rejectTarget.value = item;
	rejectReason.value = '';
	rejectModalOpen.value = true;
}

async function confirmReject() {
	const item = rejectTarget.value;
	if (!item) return;
	if (!rejectReason.value.trim()) {
		showToast(t('dashboard.admin.operator.index.toasts.rejectionReasonRequired'), 'error');
		return;
	}
	const r = await rejectContent({
		resourceType: item.type,
		resourceId: item.id,
		reason: rejectReason.value.trim(),
	});
	if (r.ok) {
		showToast(
			t('dashboard.admin.operator.index.toasts.rejected', {
				name: item.name ?? t('dashboard.admin.operator.index.fallbackNames.content'),
			})
		);
		rejectModalOpen.value = false;
		rejectTarget.value = null;
	}
}

// ── Organization status (suspend / un-suspend) ────────────────────────────────
const statusModalOpen = ref(false);
const statusTargetValue = ref<'clean' | 'warned' | 'suspended' | 'banned'>('suspended');
const statusReason = ref('');

const statusOptions = computed(() => [
	{ value: 'clean', label: t('dashboard.admin.operator.index.statusOptions.clean') },
	{ value: 'warned', label: t('dashboard.admin.operator.index.statusOptions.warned') },
	{ value: 'suspended', label: t('dashboard.admin.operator.index.statusOptions.suspended') },
	{ value: 'banned', label: t('dashboard.admin.operator.index.statusOptions.banned') },
]);

function openStatus(initial: 'clean' | 'warned' | 'suspended' | 'banned') {
	statusTargetValue.value = initial;
	statusReason.value = '';
	statusModalOpen.value = true;
}

async function confirmStatus() {
	if (!statusReason.value.trim()) {
		showToast(t('dashboard.admin.operator.index.toasts.reasonRequired'), 'error');
		return;
	}
	const r = await setOrganizationStatus({
		abuseStatus: statusTargetValue.value,
		reason: statusReason.value.trim(),
	});
	if (r.ok) {
		showToast(
			t('dashboard.admin.operator.index.toasts.statusSet', {
				status: t(`dashboard.admin.operator.index.abuseStatus.${statusTargetValue.value}`),
			})
		);
		statusModalOpen.value = false;
	}
}

const currentAbuseStatus = computed(() => orgDetail.value?.settings?.abuseStatus ?? 'clean');

// `warned` is the soft auto-warn state: flagged but sending is still allowed
// (the backend gate only stops `suspended` / `banned`). Surface it honestly so
// the operator can choose to escalate to a suspension.
const isWarnedAbuseStatus = computed(() => currentAbuseStatus.value === 'warned');

// Suspending or banning stops a workspace's mail, so the confirm says so and
// takes the danger treatment instead of a neutral "Apply".
const statusTargetBlocks = computed(() => isBlockingAbuseStatus(statusTargetValue.value));

// ── Admin roster ──────────────────────────────────────────────────────────────
const addAdminModalOpen = ref(false);
const addAdminUserId = ref('');
const addAdminRole = ref<'admin' | 'superadmin'>('admin');
const addAdminUserSelectId = useId();

// Anyone already on the roster is not a candidate — `addPlatformAdmin` refuses a
// duplicate, so offering them here could only ever produce an error toast.
const promotableUsers = computed(() => {
	const existing = new Set((admins.value ?? []).map((a) => a.authUserId));
	return (allUsers.value ?? []).filter((u) => !existing.has(u.authUserId));
});

const userOptions = computed(() => [
	{ value: '', label: t('dashboard.admin.operator.index.addAdminModal.selectUser') },
	...promotableUsers.value.map((u) => ({
		value: u.authUserId,
		label: u.name
			? t('dashboard.admin.operator.index.addAdminModal.userOption', {
					name: u.name,
					email: u.email,
				})
			: u.email,
	})),
]);

// Every member already holds platform admin. Say so, rather than opening a
// modal whose only control is an empty dropdown.
const hasPromotableUsers = computed(() => promotableUsers.value.length > 0);

// With nobody to promote, Add admin is held but stays reachable (see the
// admins tab); openAddAdmin keeps the held control inert.
const roleOptions = computed(() => [
	{ value: 'admin', label: t('dashboard.admin.operator.index.roleOptions.admin') },
	{ value: 'superadmin', label: t('dashboard.admin.operator.index.roleOptions.superadmin') },
]);

function openAddAdmin() {
	if (!hasPromotableUsers.value) return;
	addAdminUserId.value = '';
	addAdminRole.value = 'admin';
	addAdminModalOpen.value = true;
}

async function confirmAddAdmin() {
	if (!addAdminUserId.value) {
		showToast(t('dashboard.admin.operator.index.toasts.selectUser'), 'error');
		return;
	}
	const user = (allUsers.value ?? []).find((u) => u.authUserId === addAdminUserId.value);
	const r = await addPlatformAdmin({
		authUserId: addAdminUserId.value,
		email: user?.email ?? '',
		role: addAdminRole.value,
	});
	if (r.ok) {
		showToast(t('dashboard.admin.operator.index.toasts.adminAdded'));
		addAdminModalOpen.value = false;
	}
}

// Removing platform access is confirmed first, naming the account it affects.
const removeAdminTarget = ref<{ adminId: string; email: string } | null>(null);

function onRemoveAdmin(adminId: string, email: string) {
	removeAdminTarget.value = { adminId, email };
}

async function confirmRemoveAdmin() {
	const target = removeAdminTarget.value;
	if (!target) return;
	const r = await removePlatformAdmin({ adminId: target.adminId as Id<'platformAdmins'> });
	if (r.ok) {
		showToast(t('dashboard.admin.operator.index.toasts.adminRemoved', { email: target.email }));
		removeAdminTarget.value = null;
	}
}

const anyMutationLoading = computed(
	() =>
		approvingCampaign.value ||
		approvingTransactional.value ||
		rejecting.value ||
		settingStatus.value ||
		addingAdmin.value ||
		removingAdmin.value
);
</script>

<template>
	<div>
		<UiPageHeader
			class="mb-6"
			:title="t('dashboard.admin.operator.index.title')"
			:description="t('dashboard.admin.operator.index.intro')"
		/>

		<UiTabs v-model="activeTab" :tabs="tabs" :panel-id="tabPanelId" class="mb-6" />

		<div v-bind="tabPanelAttrs(tabPanelId, tabs, activeTab)">
			<UiQueryBoundary
				v-if="tabError || tabLoading"
				:loading="tabLoading"
				:error="tabError"
				@retry="retryTab"
			/>

			<OperatorOverviewTab
				v-else-if="activeTab === 'overview'"
				:stats="stats"
				:recent-abuse="recentAbuse"
				:show-delivery-stats="layout.showDeliveryStats"
			/>

			<OperatorReviewTab
				v-else-if="activeTab === 'review'"
				:review-queue="reviewQueue"
				:approving-key="approvingKey"
				:busy="anyMutationLoading"
				@approve="onApprove"
				@reject="openReject"
			/>

			<OperatorOrganizationsTab
				v-else-if="activeTab === 'organizations'"
				:current-abuse-status="currentAbuseStatus"
				:abuse-status-reason="orgDetail?.settings?.abuseStatusReason"
				:is-warned="isWarnedAbuseStatus"
				:flagged-orgs="flaggedOrgs"
				:all-orgs="allOrgs"
				:busy="anyMutationLoading"
				@set-status="openStatus"
			/>

			<OperatorAdminsTab
				v-else-if="activeTab === 'admins'"
				:admins="admins"
				:has-promotable-users="hasPromotableUsers"
				:busy="anyMutationLoading"
				@add="openAddAdmin"
				@remove="onRemoveAdmin"
			/>
		</div>

		<!-- Reject modal -->
		<UiModal
			v-model:open="rejectModalOpen"
			:title="t('dashboard.admin.operator.index.rejectModal.title')"
		>
			<div class="space-y-3">
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.admin.operator.index.rejectModal.body', { name: rejectTarget?.name }) }}
				</p>
				<UiTextarea
					v-model="rejectReason"
					:label="t('dashboard.admin.operator.index.rejectModal.reasonLabel')"
					:placeholder="t('dashboard.admin.operator.index.rejectModal.reasonPlaceholder')"
					:rows="3"
				/>
			</div>
			<template #footer>
				<UiButton variant="ghost" @click="rejectModalOpen = false">{{
					t('common.cancel')
				}}</UiButton>
				<UiButton variant="danger" :loading="rejecting" @click="confirmReject">{{
					t('dashboard.admin.operator.index.review.reject')
				}}</UiButton>
			</template>
		</UiModal>

		<!-- Org status modal -->
		<UiModal
			v-model:open="statusModalOpen"
			:title="t('dashboard.admin.operator.index.statusModal.title')"
		>
			<div class="space-y-3">
				<UiSelect
					v-model="statusTargetValue"
					:label="t('common.status')"
					:options="statusOptions"
				/>
				<UiTextarea
					v-model="statusReason"
					:label="t('dashboard.admin.operator.index.rejectModal.reasonLabel')"
					:placeholder="t('dashboard.admin.operator.index.statusModal.reasonPlaceholder')"
					:rows="3"
				/>
			</div>
			<template #footer>
				<UiButton variant="ghost" @click="statusModalOpen = false">{{
					t('common.cancel')
				}}</UiButton>
				<UiButton
					:variant="statusTargetBlocks ? 'danger' : 'primary'"
					:loading="settingStatus"
					@click="confirmStatus"
					>{{
						statusTargetBlocks
							? t('dashboard.admin.operator.index.statusModal.confirmBlock')
							: t('common.apply')
					}}</UiButton
				>
			</template>
		</UiModal>

		<!-- Add admin modal -->
		<UiModal
			v-model:open="addAdminModalOpen"
			:title="t('dashboard.admin.operator.index.addAdminModal.title')"
		>
			<div class="space-y-3">
				<!-- Every user on the instance is a candidate, so this is a native
				     select: it has typeahead and the system picker on phones. -->
				<div>
					<label :for="addAdminUserSelectId" class="label">{{
						t('dashboard.admin.operator.index.addAdminModal.userLabel')
					}}</label>
					<select :id="addAdminUserSelectId" v-model="addAdminUserId" class="input">
						<option v-for="opt in userOptions" :key="opt.value" :value="opt.value">
							{{ opt.label }}
						</option>
					</select>
				</div>
				<UiSelect
					v-model="addAdminRole"
					:label="t('dashboard.admin.operator.index.admins.role')"
					:options="roleOptions"
				/>
			</div>
			<template #footer>
				<UiButton variant="ghost" @click="addAdminModalOpen = false">{{
					t('common.cancel')
				}}</UiButton>
				<UiButton variant="primary" :loading="addingAdmin" @click="confirmAddAdmin">{{
					t('dashboard.admin.operator.index.admins.add')
				}}</UiButton>
			</template>
		</UiModal>

		<UiConfirmationDialog
			:open="removeAdminTarget !== null"
			variant="danger"
			:title="t('dashboard.admin.operator.index.removeAdminDialog.title')"
			:description="
				t('dashboard.admin.operator.index.removeAdminDialog.description', {
					email: removeAdminTarget?.email ?? '',
				})
			"
			:confirm-text="t('common.remove')"
			:is-loading="removingAdmin"
			@confirm="confirmRemoveAdmin"
			@update:open="removeAdminTarget = null"
		/>
	</div>
</template>
