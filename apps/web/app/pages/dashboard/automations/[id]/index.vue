<script setup lang="ts">
import { api } from '@owlat/api';
import type { Doc } from '@owlat/api/dataModel';
import { formatNumber } from '~/utils/formatters';
import { useFormat } from '~/composables/useFormat';
import { useRecordPaletteObjectOpen } from '~/composables/useCommandPaletteObjectRecents';
import AutomationsFunnelChart from '~/components/automations/FunnelChart.vue';
import AutomationsRunsPanel from '~/components/automations/RunsPanel.vue';
import {
	ArrowLeftIcon,
	ClockIcon,
	MailIcon,
	PauseIcon,
	PencilIcon,
	PlayIcon,
	UserCheckCornerIcon,
	UsersIcon,
	ZapIcon,
} from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const { t } = useI18n();
const { formatPercentage } = useFormat();

useHead({ title: () => t('dashboard.automations.detail.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();
const automationId = useRouteId<'automations'>();

// Fetch automation with related data
const {
	data: automation,
	isLoading: automationLoading,
	error: automationError,
	refetch: refetchAutomation,
} = useConvexQuery(api.automations.automations.getWithRelations, () => ({
	automationId: automationId.value,
}));
// ⌘K's "Jump back" list remembers the automation once it has a name.
useRecordPaletteObjectOpen(() =>
	automation.value?.name
		? { kind: 'automation', id: automationId.value, title: automation.value.name }
		: null
);

// Fetch automation stats
// Each read has its own boundary: a failed stats or funnel read is "could not
// load", never zero totals or "no steps".
const {
	data: stats,
	isLoading: statsLoading,
	error: statsError,
	refetch: refetchStats,
} = useConvexQuery(api.automations.analytics.getAutomationStats, () => ({
	automationId: automationId.value,
}));

// Fetch step analytics for funnel
const {
	data: stepAnalytics,
	isLoading: stepAnalyticsLoading,
	error: stepAnalyticsError,
	refetch: refetchStepAnalytics,
} = useConvexQuery(api.automations.analytics.getStepAnalytics, () => ({
	automationId: automationId.value,
}));

const isLoading = computed(() => automationLoading.value || statsLoading.value);

// Status + trigger badges (shared with the automations overview)
const { getStatusBadge, getTriggerDisplay } = useAutomationBadges();

// Email templates joined onto each step by getWithRelations (enrichForQuery),
// so an email step's label resolves to the real template name instead of
// "Unknown Template".
const stepEmailTemplates = computed<Doc<'emailTemplates'>[]>(() => {
	const steps = (automation.value?.steps ?? []) as Array<Record<string, unknown>>;
	return steps
		.map((s) => s['emailTemplate'])
		.filter((t): t is Doc<'emailTemplates'> => !!t && typeof t === 'object');
});

// Stats cards configuration
const statsCards = computed(() => {
	if (!stats.value) return [];
	return [
		{
			label: t('dashboard.automations.detail.index.stats.contactsEntered'),
			value: stats.value.totalEntered,
			icon: UsersIcon,
			color: 'text-brand',
			bgColor: 'bg-brand/10',
		},
		{
			label: t('common.active'),
			value: stats.value.running,
			icon: SpinnerIcon,
			color: 'text-brand',
			bgColor: 'bg-brand/10',
		},
		{
			label: t('dashboard.automations.detail.index.stats.completed'),
			value: stats.value.completed,
			icon: UserCheckCornerIcon,
			color: 'text-success',
			bgColor: 'bg-success/10',
		},
		{
			label: t('dashboard.automations.detail.index.stats.emailsSent'),
			value: stats.value.emailsSent,
			icon: MailIcon,
			color: 'text-warning',
			bgColor: 'bg-warning/10',
		},
	];
});

// Navigate to edit
const handleEdit = () => {
	router.push(`/dashboard/automations/${automationId.value}/edit`);
};

// Pause / Resume from the detail page, like the list row and the builder.
const { showToast } = useToast();
const { run: pauseAutomation } = useBackendOperation(api.automations.automations.pause, {
	label: () => t('dashboard.automations.index.operations.pause'),
});
const { run: resumeAutomation } = useBackendOperation(api.automations.automations.resume, {
	label: () => t('dashboard.automations.index.operations.resume'),
});
const isToggling = ref(false);
const handleToggleStatus = async () => {
	const current = automation.value;
	if (!current || isToggling.value) return;
	const pausing = current.status === 'active';
	isToggling.value = true;
	try {
		const outcome = pausing
			? await pauseAutomation({ automationId: automationId.value })
			: await resumeAutomation({ automationId: automationId.value });
		if (!outcome.ok) return;
		showToast(
			pausing
				? t('dashboard.automations.index.toasts.paused', { name: current.name })
				: t('dashboard.automations.index.toasts.activated', { name: current.name })
		);
	} finally {
		isToggling.value = false;
	}
};
</script>

<template>
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
		<!-- A failed read is not a missing automation. -->
		<UiQueryBoundary v-if="automationError" :error="automationError" @retry="refetchAutomation" />

		<!-- Loading State -->
		<DashboardDetailSkeleton
			v-else-if="isLoading && !automation"
			:label="t('dashboard.automations.detail.index.loading')"
			back="link"
			meta
			:stats="4"
			body="cards"
		/>

		<!-- Automation Not Found -->
		<div
			v-else-if="!automation"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox :icon="ZapIcon" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.automations.detail.index.notFoundTitle') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1">
				{{ t('dashboard.automations.detail.index.notFoundDescription') }}
			</p>
			<UiButton variant="secondary" to="/dashboard/automations" class="mt-6">
				{{ t('dashboard.automations.detail.index.backToAutomations') }}
			</UiButton>
		</div>

		<!-- Analytics Content -->
		<div v-else>
			<!-- Header -->
			<div class="mb-8">
				<NuxtLink
					to="/dashboard/automations"
					class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary text-sm mb-4 transition-colors"
				>
					<ArrowLeftIcon class="w-4 h-4" />
					{{ t('dashboard.automations.detail.index.backToAutomations') }}
				</NuxtLink>
				<UiPageHeader :title="automation.name" :description="automation.description">
					<template #meta>
						<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-tertiary">
							<span
								:class="[
									'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
									getStatusBadge(automation.status).color,
								]"
							>
								<component :is="getStatusBadge(automation.status).icon" class="w-3 h-3" />
								{{ t(getStatusBadge(automation.status).label) }}
							</span>
							<div class="flex items-center gap-1.5">
								<component :is="getTriggerDisplay(automation.triggerType).icon" class="w-4 h-4" />
								{{ t(getTriggerDisplay(automation.triggerType).label) }}
							</div>
							<div class="flex items-center gap-1.5">
								<ClockIcon class="w-4 h-4" />
								{{
									t('dashboard.automations.detail.index.createdAt', {
										date: formatDateTime(automation.createdAt),
									})
								}}
							</div>
						</div>
					</template>
					<template #actions>
						<UiButton
							v-if="automation.status === 'active' || automation.status === 'paused'"
							variant="secondary"
							:loading="isToggling"
							@click="handleToggleStatus"
						>
							<template v-if="!isToggling" #iconLeft>
								<component
									:is="automation.status === 'active' ? PauseIcon : PlayIcon"
									class="w-4 h-4"
								/>
							</template>
							{{
								automation.status === 'active'
									? t('dashboard.automations.detail.edit.pause')
									: t('dashboard.automations.detail.edit.resume')
							}}
						</UiButton>
						<UiButton variant="secondary" class="gap-2" @click="handleEdit">
							<PencilIcon class="w-4 h-4" />
							{{ t('dashboard.automations.detail.index.editAutomation') }}
						</UiButton>
					</template>
				</UiPageHeader>
			</div>

			<UiQueryBoundary
				v-if="statsError"
				class="mb-8"
				:error="statsError"
				:error-title="t('dashboard.automations.detail.index.statsLoadError')"
				@retry="refetchStats"
			/>

			<template v-else>
				<!-- Stats Cards -->
				<div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
					<div v-for="stat in statsCards" :key="stat.label" class="card p-4">
						<div class="flex items-center gap-3 mb-3">
							<div :class="['p-2 rounded-lg', stat.bgColor]">
								<component :is="stat.icon" :class="['w-4 h-4', stat.color]" size="1em" />
							</div>
							<span class="text-sm text-text-secondary">{{ stat.label }}</span>
						</div>
						<span class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
							{{ formatNumber(stat.value) }}
						</span>
					</div>
				</div>

				<!-- Completion Rate Card -->
				<div class="card p-6 mb-8">
					<div class="flex items-center justify-between mb-4">
						<h3 class="text-lg font-medium text-text-primary">
							{{ t('dashboard.automations.detail.index.completionRate') }}
						</h3>
						<span class="text-3xl font-semibold text-text-primary tabular-nums">{{
							formatPercentage(stats?.completionRate || 0, 0, false)
						}}</span>
					</div>
					<UiProgressBar
						size="sm"
						:value="Math.min(stats?.completionRate || 0, 100)"
						:aria-label="t('dashboard.automations.detail.index.completionRateLabel')"
					/>
					<p class="text-sm text-text-tertiary mt-3">
						{{
							t('dashboard.automations.detail.index.completedOfEntered', {
								completed: formatNumber(stats?.completed || 0),
								total: formatNumber(stats?.totalEntered || 0),
							})
						}}
					</p>
				</div>
			</template>

			<!-- Funnel Visualization -->
			<div class="card p-6 mb-8">
				<h3 class="text-lg font-medium text-text-primary mb-6">
					{{ t('dashboard.automations.detail.index.funnel.title') }}
				</h3>

				<UiQueryBoundary
					v-if="stepAnalyticsError"
					:error="stepAnalyticsError"
					:error-title="t('dashboard.automations.detail.index.funnel.loadError')"
					@retry="refetchStepAnalytics"
				/>

				<div
					v-else-if="stepAnalyticsLoading && !stepAnalytics"
					class="flex items-center justify-center py-12"
				>
					<UiSpinner delay />
				</div>

				<!-- Empty state -->
				<div
					v-else-if="!stepAnalytics || stepAnalytics.length === 0"
					class="flex flex-col items-center justify-center py-12 text-center"
				>
					<ZapIcon class="w-12 h-12 text-text-tertiary mb-3" :stroke-width="1.5" />
					<p class="text-text-secondary">
						{{ t('dashboard.automations.detail.index.funnel.emptyTitle') }}
					</p>
					<p class="text-sm text-text-tertiary mt-1">
						{{ t('dashboard.automations.detail.index.funnel.emptyDescription') }}
					</p>
					<UiButton variant="secondary" class="mt-4" @click="handleEdit">
						{{ t('dashboard.automations.detail.index.funnel.configureSteps') }}
					</UiButton>
				</div>

				<!-- Funnel chart -->
				<AutomationsFunnelChart
					v-else
					:steps="stepAnalytics"
					:trigger-type="automation.triggerType"
					:total-entered="stats?.totalEntered || 0"
					:email-templates="stepEmailTemplates"
				/>
			</div>

			<!-- Contacts List: filterable by status, and by the list's health links -->
			<AutomationsRunsPanel :automation-id="automationId" />
		</div>
	</div>
</template>
