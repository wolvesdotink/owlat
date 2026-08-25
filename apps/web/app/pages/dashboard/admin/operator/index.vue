<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.operator.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'platform-admin'],
});

const { showToast } = useToast();

// ── Tabs ──────────────────────────────────────────────────────────────────────
type TabValue = 'overview' | 'review' | 'organizations' | 'admins';
const activeTab = ref<TabValue>('overview');

// ── Queries (all requirePlatformAdmin-gated; no org arg needed) ───────────────
const { data: stats } = useConvexQuery(api.platformAdmin.queries.getPlatformStats, () => ({}));
const { data: recentAbuse } = useConvexQuery(api.platformAdmin.queries.listRecentAbuse, () => ({}));
const { data: reviewQueue } = useConvexQuery(
	api.platformAdmin.queries.getContentReviewQueue,
	() => ({})
);
const { data: flaggedOrgs } = useConvexQuery(
	api.platformAdmin.queries.listFlaggedOrganizations,
	() => ({})
);
const { data: allOrgs } = useConvexQuery(
	api.platformAdmin.queries.listAllOrganizations,
	() => ({})
);
const { data: orgDetail } = useConvexQuery(
	api.platformAdmin.queries.getOrganizationDetail,
	() => ({})
);
const { data: admins } = useConvexQuery(api.platformAdmin.queries.listPlatformAdmins, () => ({}));
const { data: allUsers } = useConvexQuery(api.platformAdmin.queries.listAllUsers, () => ({}));

const tabs = computed(() => [
	{ value: 'overview', label: t('dashboard.admin.operator.index.tabs.overview') },
	{
		value: 'review',
		label: t('dashboard.admin.operator.index.tabs.review'),
		count: reviewQueue.value?.pendingCount ?? 0,
	},
	{
		value: 'organizations',
		label: t('dashboard.admin.operator.index.tabs.organizations'),
		count: flaggedOrgs.value?.length ?? 0,
	},
	{
		value: 'admins',
		label: t('dashboard.admin.operator.index.tabs.admins'),
		count: admins.value?.length ?? 0,
	},
]);

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
type ReviewItem = {
	type: 'campaign' | 'transactional';
	id: string;
	name?: string;
	subject?: string | null;
	scan: { score: number; level: string } | null;
	updatedAt?: number;
};

async function onApprove(item: ReviewItem) {
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
const rejectTarget = ref<ReviewItem | null>(null);
const rejectReason = ref('');

function openReject(item: ReviewItem) {
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
			t('dashboard.admin.operator.index.toasts.statusSet', { status: statusTargetValue.value })
		);
		statusModalOpen.value = false;
	}
}

const currentAbuseStatus = computed(() => orgDetail.value?.settings.abuseStatus ?? 'clean');

// `warned` is the soft auto-warn state: flagged but sending is still allowed
// (the backend gate only stops `suspended` / `banned`). Surface it honestly so
// the operator can choose to escalate to a suspension.
const isWarnedAbuseStatus = computed(() => currentAbuseStatus.value === 'warned');

// ── Admin roster ──────────────────────────────────────────────────────────────
const addAdminModalOpen = ref(false);
const addAdminUserId = ref('');
const addAdminRole = ref<'admin' | 'superadmin'>('admin');

const userOptions = computed(() => [
	{ value: '', label: t('dashboard.admin.operator.index.addAdminModal.selectUser') },
	...(allUsers.value ?? []).map((u) => ({
		value: u.authUserId,
		label: u.name
			? t('dashboard.admin.operator.index.addAdminModal.userOption', {
					name: u.name,
					email: u.email,
				})
			: u.email,
	})),
]);

const roleOptions = computed(() => [
	{ value: 'admin', label: t('dashboard.admin.operator.index.roleOptions.admin') },
	{ value: 'superadmin', label: t('dashboard.admin.operator.index.roleOptions.superadmin') },
]);

function openAddAdmin() {
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

async function onRemoveAdmin(adminId: string, email: string) {
	const r = await removePlatformAdmin({ adminId: adminId as Id<'platformAdmins'> });
	if (r.ok) showToast(t('dashboard.admin.operator.index.toasts.adminRemoved', { email }));
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
	<div class="p-6 lg:p-8 max-w-[1100px] mx-auto">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/admin"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				{{ t('dashboard.admin.operator.index.backToSettings') }}
			</NuxtLink>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:shield-alert" size="lg" variant="brand" rounded="xl" />
				<div>
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ t('dashboard.admin.operator.index.title') }}
					</h1>
					<p class="mt-1 text-text-secondary">
						{{ t('dashboard.admin.operator.index.intro') }}
					</p>
				</div>
			</div>
		</div>

		<UiTabs v-model="activeTab" :tabs="tabs" class="mb-6" />

		<!-- ── OVERVIEW ── -->
		<div v-if="activeTab === 'overview'" class="space-y-6">
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<div class="card p-5">
					<p class="text-xs text-text-tertiary uppercase tracking-wider">
						{{ t('dashboard.admin.operator.index.stats.totalSent') }}
					</p>
					<p class="mt-1 text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ stats?.sending.totalSent ?? 0 }}
					</p>
				</div>
				<div class="card p-5">
					<p class="text-xs text-text-tertiary uppercase tracking-wider">
						{{ t('dashboard.admin.operator.index.stats.bounceRate') }}
					</p>
					<p class="mt-1 text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ formatRate(stats?.sending.bounceRate) }}
					</p>
				</div>
				<div class="card p-5">
					<p class="text-xs text-text-tertiary uppercase tracking-wider">
						{{ t('dashboard.admin.operator.index.stats.complaintRate') }}
					</p>
					<p class="mt-1 text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ formatRate(stats?.sending.complaintRate) }}
					</p>
				</div>
				<div class="card p-5">
					<p class="text-xs text-text-tertiary uppercase tracking-wider">
						{{ t('dashboard.admin.operator.index.stats.abuseStatus') }}
					</p>
					<div class="mt-1.5">
						<UiBadge :variant="abuseStatusVariant(stats?.abuseStatus)" size="md">
							{{ stats?.abuseStatus ?? 'clean' }}
						</UiBadge>
					</div>
				</div>
			</div>

			<!-- Recent abuse signals -->
			<div class="card">
				<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-4">
					{{ t('dashboard.admin.operator.index.abuse.title') }}
				</h3>
				<div
					v-if="
						!recentAbuse ||
						(recentAbuse.flaggedScans.length === 0 && recentAbuse.pendingReview.length === 0)
					"
					class="text-caption text-text-tertiary"
				>
					{{ t('dashboard.admin.operator.index.abuse.empty') }}
				</div>
				<div v-else class="space-y-4">
					<div v-if="recentAbuse.pendingReview.length">
						<p class="text-xs font-medium text-text-secondary mb-2">
							{{
								t('dashboard.admin.operator.index.abuse.pendingReview', {
									count: recentAbuse.pendingReview.length,
								})
							}}
						</p>
						<ul class="space-y-1">
							<li
								v-for="c in recentAbuse.pendingReview"
								:key="c.id"
								class="flex items-center justify-between text-caption text-text-primary"
							>
								<span>{{ c.name }}</span>
								<span class="text-text-tertiary">{{ formatRelativeTime(c.updatedAt) }}</span>
							</li>
						</ul>
					</div>
					<div v-if="recentAbuse.flaggedScans.length">
						<p class="text-xs font-medium text-text-secondary mb-2">
							{{
								t('dashboard.admin.operator.index.abuse.flaggedScans', {
									count: recentAbuse.flaggedScans.length,
								})
							}}
						</p>
						<ul class="space-y-1">
							<li
								v-for="(s, i) in recentAbuse.flaggedScans"
								:key="`${s.resourceType}-${s.resourceId}-${i}`"
								class="flex items-center justify-between text-caption"
							>
								<span class="text-text-primary">
									{{
										t('dashboard.admin.operator.index.abuse.scanEntry', {
											resourceType: s.resourceType,
											score: s.score,
										})
									}}
								</span>
								<UiBadge :variant="scanLevelVariant(s.level)">{{ s.level }}</UiBadge>
							</li>
						</ul>
					</div>
				</div>
			</div>
		</div>

		<!-- ── CONTENT REVIEW ── -->
		<div v-else-if="activeTab === 'review'" class="space-y-6">
			<div class="card">
				<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-4">
					{{ t('dashboard.admin.operator.index.review.title') }}
				</h3>

				<UiEmptyState
					v-if="!reviewQueue || reviewQueue.pending.length === 0"
					icon="lucide:check-circle-2"
					:title="t('dashboard.admin.operator.index.review.emptyTitle')"
					:description="t('dashboard.admin.operator.index.review.emptyDescription')"
				/>

				<div v-else class="space-y-3">
					<div
						v-for="item in reviewQueue.pending as ReviewItem[]"
						:key="`${item.type}-${item.id}`"
						class="flex items-start justify-between gap-4 rounded-lg shadow-surface-1 p-4"
					>
						<div class="min-w-0">
							<div class="flex items-center gap-2 flex-wrap">
								<UiBadge variant="neutral">{{ item.type }}</UiBadge>
								<span class="font-medium text-text-primary truncate">{{ item.name }}</span>
								<UiBadge v-if="item.scan" :variant="scanLevelVariant(item.scan.level)">
									{{ item.scan.level }} · {{ item.scan.score }}
								</UiBadge>
							</div>
							<p v-if="item.subject" class="mt-1 text-caption text-text-secondary truncate">
								{{ item.subject }}
							</p>
							<p class="mt-1 text-xs text-text-tertiary">
								{{
									t('dashboard.admin.operator.index.review.updated', {
										time: formatRelativeTime(item.updatedAt),
									})
								}}
							</p>
						</div>
						<div class="flex gap-2 shrink-0">
							<UiButton
								variant="primary"
								size="sm"
								:loading="approvingCampaign || approvingTransactional"
								:disabled="anyMutationLoading"
								@click="onApprove(item)"
							>
								{{ t('dashboard.admin.operator.index.review.approve') }}
							</UiButton>
							<UiButton
								variant="danger-outline"
								size="sm"
								:disabled="anyMutationLoading"
								@click="openReject(item)"
							>
								{{ t('dashboard.admin.operator.index.review.reject') }}
							</UiButton>
						</div>
					</div>
				</div>
			</div>

			<!-- Recently reviewed -->
			<div v-if="reviewQueue && reviewQueue.recentlyReviewed.length" class="card">
				<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-4">
					{{ t('dashboard.admin.operator.index.review.recentlyReviewed') }}
				</h3>
				<ul class="space-y-2">
					<li
						v-for="(a, i) in reviewQueue.recentlyReviewed"
						:key="i"
						class="flex items-center justify-between text-caption"
					>
						<span class="text-text-primary">{{ t(auditActionLabel(a.action)) }}</span>
						<span class="text-text-tertiary">{{ formatRelativeTime(a.createdAt) }}</span>
					</li>
				</ul>
			</div>
		</div>

		<!-- ── ORGANIZATIONS ── -->
		<div v-else-if="activeTab === 'organizations'" class="space-y-6">
			<!-- Sending status control -->
			<div class="card">
				<div class="flex items-start justify-between gap-4 flex-wrap">
					<div>
						<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-2">
							{{ t('dashboard.admin.operator.index.sending.title') }}
						</h3>
						<div class="flex items-center gap-2">
							<UiBadge :variant="abuseStatusVariant(currentAbuseStatus)" size="md">{{
								currentAbuseStatus
							}}</UiBadge>
							<span
								v-if="isBlockingAbuseStatus(currentAbuseStatus)"
								class="text-caption text-error"
							>
								{{ t('dashboard.admin.operator.index.sending.blocked') }}
							</span>
							<span v-else-if="isWarnedAbuseStatus" class="text-caption text-warning">
								{{ t('dashboard.admin.operator.index.sending.warned') }}
							</span>
						</div>
						<p
							v-if="orgDetail?.settings.abuseStatusReason"
							class="mt-2 text-caption text-text-secondary"
						>
							{{
								t('dashboard.admin.operator.index.sending.reason', {
									reason: orgDetail.settings.abuseStatusReason,
								})
							}}
						</p>
					</div>
					<div class="flex gap-2">
						<UiButton
							v-if="isBlockingAbuseStatus(currentAbuseStatus)"
							variant="primary"
							size="sm"
							:disabled="anyMutationLoading"
							@click="openStatus('clean')"
						>
							{{ t('dashboard.admin.operator.index.sending.unsuspend') }}
						</UiButton>
						<UiButton
							v-else
							variant="danger-outline"
							size="sm"
							:disabled="anyMutationLoading"
							@click="openStatus('suspended')"
						>
							{{ t('dashboard.admin.operator.index.sending.suspend') }}
						</UiButton>
					</div>
				</div>
			</div>

			<!-- Flagged organizations -->
			<div class="card">
				<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-4">
					{{ t('dashboard.admin.operator.index.flagged.title') }}
				</h3>
				<div
					v-if="!flaggedOrgs || flaggedOrgs.length === 0"
					class="text-caption text-text-tertiary"
				>
					{{ t('dashboard.admin.operator.index.flagged.empty') }}
				</div>
				<ul v-else class="space-y-3">
					<li
						v-for="(o, i) in flaggedOrgs"
						:key="i"
						class="flex items-center justify-between gap-4 rounded-lg shadow-surface-1 p-4"
					>
						<div>
							<div class="flex items-center gap-2">
								<UiBadge :variant="abuseStatusVariant(o.abuseStatus)">{{ o.abuseStatus }}</UiBadge>
								<UiBadge :variant="riskLevelVariant(o.riskLevel)">
									{{ t('dashboard.admin.operator.index.flagged.risk', { level: o.riskLevel }) }}
								</UiBadge>
							</div>
							<p class="mt-1 text-xs text-text-tertiary">
								{{
									t('dashboard.admin.operator.index.flagged.rates', {
										bounce: formatRate(o.bounceRate),
										complaint: formatRate(o.complaintRate),
										sent: o.totalSent,
									})
								}}
							</p>
						</div>
					</li>
				</ul>
			</div>

			<!-- All organizations -->
			<div class="card">
				<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-4">
					{{ t('dashboard.admin.operator.index.workspaces.title') }}
				</h3>
				<table class="w-full text-caption">
					<thead>
						<tr class="border-b border-border-subtle text-text-tertiary">
							<th class="text-left py-2 font-medium">
								{{ t('dashboard.admin.operator.index.workspaces.sender') }}
							</th>
							<th class="text-left py-2 font-medium">{{ t('common.status') }}</th>
							<th class="text-left py-2 font-medium">
								{{ t('dashboard.admin.operator.index.workspaces.risk') }}
							</th>
							<th class="text-right py-2 font-medium">
								{{ t('dashboard.admin.operator.index.workspaces.contacts') }}
							</th>
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="(o, i) in allOrgs ?? []"
							:key="i"
							class="border-b border-border-subtle last:border-b-0"
						>
							<td class="py-2 text-text-primary">
								{{ o.defaultFromName || o.defaultFromEmail || '—' }}
							</td>
							<td class="py-2">
								<UiBadge :variant="abuseStatusVariant(o.abuseStatus)">{{ o.abuseStatus }}</UiBadge>
							</td>
							<td class="py-2">
								<UiBadge :variant="riskLevelVariant(o.riskLevel)">{{ o.riskLevel }}</UiBadge>
							</td>
							<td class="py-2 text-right text-text-secondary">{{ o.contactCount }}</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>

		<!-- ── ADMINS ── -->
		<div v-else-if="activeTab === 'admins'" class="space-y-6">
			<div class="card">
				<div class="flex items-center justify-between mb-4">
					<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider">
						{{ t('dashboard.admin.operator.index.admins.title') }}
					</h3>
					<UiButton
						variant="secondary"
						size="sm"
						:disabled="anyMutationLoading"
						@click="openAddAdmin"
					>
						<template #iconLeft>
							<Icon name="lucide:plus" class="w-4 h-4" />
						</template>
						{{ t('dashboard.admin.operator.index.admins.add') }}
					</UiButton>
				</div>

				<table class="w-full text-caption">
					<thead>
						<tr class="border-b border-border-subtle text-text-tertiary">
							<th class="text-left py-2 font-medium">{{ t('common.email') }}</th>
							<th class="text-left py-2 font-medium">
								{{ t('dashboard.admin.operator.index.admins.role') }}
							</th>
							<th class="text-left py-2 font-medium">
								{{ t('dashboard.admin.operator.index.admins.added') }}
							</th>
							<th class="text-right py-2 font-medium" />
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="a in admins ?? []"
							:key="a.id"
							class="border-b border-border-subtle last:border-b-0"
						>
							<td class="py-2 text-text-primary">{{ a.email }}</td>
							<td class="py-2">
								<UiBadge :variant="a.role === 'superadmin' ? 'warning' : 'neutral'">{{
									a.role
								}}</UiBadge>
							</td>
							<td class="py-2 text-text-secondary">{{ formatRelativeTime(a.createdAt) }}</td>
							<td class="py-2 text-right">
								<UiButton
									variant="danger-ghost"
									size="sm"
									:disabled="anyMutationLoading"
									@click="onRemoveAdmin(a.id, a.email)"
								>
									{{ t('common.remove') }}
								</UiButton>
							</td>
						</tr>
					</tbody>
				</table>
				<p class="mt-3 text-xs text-text-tertiary">
					{{ t('dashboard.admin.operator.index.admins.footnote') }}
				</p>
			</div>
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
				<UiButton variant="primary" :loading="settingStatus" @click="confirmStatus">{{
					t('common.apply')
				}}</UiButton>
			</template>
		</UiModal>

		<!-- Add admin modal -->
		<UiModal
			v-model:open="addAdminModalOpen"
			:title="t('dashboard.admin.operator.index.addAdminModal.title')"
		>
			<div class="space-y-3">
				<UiSelect
					v-model="addAdminUserId"
					:label="t('dashboard.admin.operator.index.addAdminModal.userLabel')"
					:options="userOptions"
				/>
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
	</div>
</template>
