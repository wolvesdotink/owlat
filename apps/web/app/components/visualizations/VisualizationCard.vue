<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { formatDate } from '~/utils/formatters';
import { budgetRefusalReason } from '~/utils/aiBudget';
import { ActivityIcon, PinIcon, PinOffIcon, ReloadIcon, TrashIcon } from '@coolicons/vue';

const props = defineProps<{
	id: Id<'visualizations'>;
	title: string;
	description?: string | null;
	html: string;
	pinned: boolean;
	createdAt: number;
	// Allowlisted dataset key the chart was built from, when it uses live
	// account data. Undefined for illustrative sample-data charts (not
	// refreshable).
	dataQuery?: string | null;
	/** Generation was refused for budget: shown in place of the page, localized. */
	budgetRefusal?: unknown;
}>();

const emit = defineEmits<{
	toggled: [];
	removed: [];
	refreshed: [];
}>();

const { t, locale } = useI18n();

const { run: togglePin } = useBackendOperation(api.analytics.visualizationAgent.togglePin, {
	label: () => t('components.visualizations.visualizationCard.togglePinOperation'),
});
const { run: remove } = useBackendOperation(api.analytics.visualizationAgent.remove, {
	label: () => t('components.visualizations.visualizationCard.removeOperation'),
});
const { run: regenerate } = useBackendOperation(api.analytics.visualizationAgent.regenerate, {
	label: () => t('components.visualizations.visualizationCard.refreshOperation'),
});

const createdAtLabel = computed(() => formatDate(props.createdAt, 'medium', locale.value));

const isLiveData = computed(() => !!props.dataQuery);
const isBudgetRefused = computed(() => budgetRefusalReason(props.budgetRefusal) !== null);

const isTogglingPin = ref(false);
const isRemoving = ref(false);
const isRefreshing = ref(false);
const showConfirmRemove = ref(false);

const handleRefresh = async () => {
	isRefreshing.value = true;
	const result = await regenerate({ id: props.id });
	isRefreshing.value = false;
	if (!result.ok) return;
	emit('refreshed');
};

const handleTogglePin = async () => {
	isTogglingPin.value = true;
	const result = await togglePin({ id: props.id });
	isTogglingPin.value = false;
	if (!result.ok) return;
	emit('toggled');
};

const handleRemove = async () => {
	isRemoving.value = true;
	const result = await remove({ id: props.id });
	isRemoving.value = false;
	if (!result.ok) return;
	showConfirmRemove.value = false;
	emit('removed');
};
</script>

<template>
	<div class="card overflow-hidden">
		<!-- Header -->
		<div class="flex items-start justify-between mb-4">
			<div class="min-w-0">
				<!-- h2: the cards are the page's sections under its h1. -->
				<h2 class="text-text-primary font-medium truncate" :title="title">{{ title }}</h2>
				<p
					v-if="description"
					class="text-sm text-text-secondary mt-0.5 line-clamp-2"
					:title="description"
				>
					{{ description }}
				</p>
				<div class="flex items-center gap-2 mt-1">
					<p class="text-xs text-text-tertiary">{{ createdAtLabel }}</p>
					<span
						v-if="isLiveData"
						class="inline-flex items-center gap-1 text-xs text-brand bg-brand-subtle rounded px-1.5 py-0.5"
						:title="t('components.visualizations.visualizationCard.liveDataTooltip')"
					>
						<ActivityIcon class="w-3 h-3" />
						{{ t('components.visualizations.visualizationCard.liveDataBadge') }}
					</span>
				</div>
			</div>
			<div class="flex items-center gap-1 flex-shrink-0 ml-3">
				<UiTooltip
					v-if="isLiveData"
					:text="t('components.visualizations.visualizationCard.refreshTooltip')"
				>
					<button
						type="button"
						class="inline-flex items-center justify-center p-1.5 pointer-coarse:size-11 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors disabled:opacity-50"
						:aria-label="t('components.visualizations.visualizationCard.refreshTooltip')"
						:disabled="isRefreshing"
						@click="handleRefresh"
					>
						<ReloadIcon
							class="w-4 h-4"
							:class="{ 'animate-spin motion-reduce:animate-none': isRefreshing }"
						/>
					</button>
				</UiTooltip>
				<UiTooltip
					:text="
						pinned
							? t('components.visualizations.visualizationCard.unpinTooltip')
							: t('components.visualizations.visualizationCard.pinTooltip')
					"
				>
					<button
						type="button"
						class="inline-flex items-center justify-center p-1.5 pointer-coarse:size-11 rounded transition-colors"
						:class="
							pinned
								? 'text-brand bg-brand-subtle hover:bg-brand-subtle/80'
								: 'text-text-tertiary hover:text-text-primary hover:bg-bg-surface'
						"
						:aria-label="
							pinned
								? t('components.visualizations.visualizationCard.unpinTooltip')
								: t('components.visualizations.visualizationCard.pinTooltip')
						"
						:disabled="isTogglingPin"
						@click="handleTogglePin"
					>
						<component :is="pinned ? PinOffIcon : PinIcon" class="w-4 h-4" />
					</button>
				</UiTooltip>
				<UiTooltip :text="t('components.visualizations.visualizationCard.removeTooltip')">
					<button
						type="button"
						class="inline-flex items-center justify-center p-1.5 pointer-coarse:size-11 rounded text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors"
						:aria-label="t('components.visualizations.visualizationCard.removeTooltip')"
						@click="showConfirmRemove = true"
					>
						<TrashIcon class="w-4 h-4" />
					</button>
				</UiTooltip>
			</div>
		</div>

		<!-- Visualization iframe, or why there is none -->
		<AiBudgetRefusal v-if="isBudgetRefused" :refusal="budgetRefusal" variant="panel" />
		<VisualizationsVisualizationRenderer v-else :html="html" :title="title" min-height="250px" />

		<!-- Remove confirmation -->
		<UiConfirmationDialog
			v-model:open="showConfirmRemove"
			variant="danger"
			:title="t('components.visualizations.visualizationCard.confirmRemoveTitle')"
			:description="t('components.visualizations.visualizationCard.confirmRemoveBody')"
			:confirm-text="t('common.remove')"
			:is-loading="isRemoving"
			@confirm="handleRemove"
		/>
	</div>
</template>
