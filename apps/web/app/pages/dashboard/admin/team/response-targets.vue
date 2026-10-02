<script setup lang="ts">
/**
 * Team Inbox response targets (SLA): how fast the team should answer, measured
 * in business or calendar hours. Off until an admin turns it on. While on,
 * every open thread carries a reply deadline: the inbox list shows it, filters
 * and sorts by it, and a missed deadline notifies the assignee (or every inbox
 * reader when nobody owns the thread).
 */
import { api } from '@owlat/api';
import { DEFAULT_SLA_FORM_POLICY, type SlaPolicyShape } from '~/utils/inboxSlaPolicyForm';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.team.responseTargets.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
	requiresFeature: 'inbox',
});

const { isAdmin, showAdminGate } = usePermissions();
const { showToast } = useToast();

const {
	data: stored,
	isLoading,
	error,
	refetch,
} = useConvexQuery(api.inbox.sla.policy.getPolicy, () => (isAdmin.value ? {} : 'skip'));

// Nothing saved yet: start from the defaults, in the browser's time zone.
const policy = computed<SlaPolicyShape>(() => {
	const saved = stored.value;
	if (saved) {
		const { updatedAt: _updatedAt, ...rest } = saved;
		return rest;
	}
	let timeZone = 'UTC';
	try {
		timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		// Keep UTC.
	}
	return { ...DEFAULT_SLA_FORM_POLICY, timeZone };
});

const { run: savePolicy, isLoading: isSaving } = useBackendOperation(
	api.inbox.sla.policy.savePolicy,
	{ label: () => t('dashboard.admin.team.responseTargets.saveOperation') }
);

async function onSave(next: SlaPolicyShape) {
	const result = await savePolicy(next);
	if (result.ok) showToast(t('dashboard.admin.team.responseTargets.saved'));
}
</script>

<template>
	<div>
		<UiPageHeader
			class="mb-6"
			:title="t('dashboard.admin.team.responseTargets.title')"
			:description="t('dashboard.admin.team.responseTargets.subtitle')"
		>
			<template #actions>
				<UiButton to="/dashboard/inbox/analytics" variant="secondary" class="gap-2">
					<Icon name="lucide:bar-chart-3" class="w-4 h-4" />
					{{ t('dashboard.admin.team.responseTargets.analyticsLink') }}
				</UiButton>
			</template>
		</UiPageHeader>

		<div
			v-if="showAdminGate"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:lock" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.admin.team.responseTargets.adminGate.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				{{ t('dashboard.admin.team.responseTargets.adminGate.description') }}
			</p>
		</div>
		<UiQueryBoundary
			v-else
			:loading="isLoading"
			:error="error"
			:error-title="t('dashboard.admin.team.responseTargets.errorTitle')"
			@retry="refetch"
		>
			<template #loading>
				<div
					class="h-64 animate-pulse motion-reduce:animate-none rounded-xl bg-bg-surface"
					role="status"
					aria-live="polite"
				/>
			</template>
			<InboxSlaPolicyForm :policy="policy" :busy="isSaving" @save="onSave" />
		</UiQueryBoundary>
	</div>
</template>
