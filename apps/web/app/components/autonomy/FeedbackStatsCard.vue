<script setup lang="ts">
interface CategoryStats {
	approved: number;
	rejected: number;
	edited: number;
}

interface Props {
	stats: Record<string, CategoryStats> | null;
}

const props = defineProps<Props>();

const { t } = useI18n();

const totals = computed(() => {
	if (!props.stats) return { approved: 0, rejected: 0, edited: 0 };
	const result = { approved: 0, rejected: 0, edited: 0 };
	for (const cat of Object.values(props.stats)) {
		result.approved += cat.approved;
		result.rejected += cat.rejected;
		result.edited += cat.edited;
	}
	return result;
});

const total = computed(() => totals.value.approved + totals.value.rejected + totals.value.edited);

const hasData = computed(() => total.value > 0);

const approvedWidth = computed(() => {
	if (!hasData.value) return 0;
	return (totals.value.approved / total.value) * 100;
});

const rejectedWidth = computed(() => {
	if (!hasData.value) return 0;
	return (totals.value.rejected / total.value) * 100;
});

const editedWidth = computed(() => {
	if (!hasData.value) return 0;
	return (totals.value.edited / total.value) * 100;
});
</script>

<template>
	<UiCard>
		<div class="flex items-center gap-3 mb-4">
			<UiIconBox icon="lucide:message-circle" size="sm" variant="surface" />
			<div>
				<h3 class="text-base font-medium text-text-primary">
					{{ t('components.autonomy.feedbackStatsCard.title') }}
				</h3>
				<p class="text-xs text-text-tertiary">
					{{ t('components.autonomy.feedbackStatsCard.subtitle') }}
				</p>
			</div>
		</div>

		<div v-if="!hasData" class="py-4 text-center">
			<p class="text-sm text-text-tertiary">
				{{ t('components.autonomy.feedbackStatsCard.empty') }}
			</p>
		</div>

		<template v-else>
			<!-- Stats boxes -->
			<div class="grid grid-cols-3 gap-3 mb-4">
				<div class="p-3 rounded-lg bg-success-subtle text-center">
					<p class="text-xl font-semibold text-success">{{ totals.approved }}</p>
					<p class="text-xs text-success/80 mt-0.5">
						{{ t('components.autonomy.feedbackStatsCard.approved') }}
					</p>
				</div>
				<div class="p-3 rounded-lg bg-error-subtle text-center">
					<p class="text-xl font-semibold text-error">{{ totals.rejected }}</p>
					<p class="text-xs text-error/80 mt-0.5">
						{{ t('components.autonomy.feedbackStatsCard.rejected') }}
					</p>
				</div>
				<div class="p-3 rounded-lg bg-warning-subtle text-center">
					<p class="text-xl font-semibold text-warning">{{ totals.edited }}</p>
					<p class="text-xs text-warning/80 mt-0.5">
						{{ t('components.autonomy.feedbackStatsCard.edited') }}
					</p>
				</div>
			</div>

			<!-- Proportional bar -->
			<div class="w-full h-3 bg-bg-surface rounded-full overflow-hidden flex">
				<div
					v-if="approvedWidth > 0"
					class="h-full bg-success transition-all duration-(--motion-slow)"
					:style="{ width: `${approvedWidth}%` }"
				/>
				<div
					v-if="editedWidth > 0"
					class="h-full bg-warning transition-all duration-(--motion-slow)"
					:style="{ width: `${editedWidth}%` }"
				/>
				<div
					v-if="rejectedWidth > 0"
					class="h-full bg-error transition-all duration-(--motion-slow)"
					:style="{ width: `${rejectedWidth}%` }"
				/>
			</div>

			<p class="text-xs text-text-tertiary mt-2 text-center">
				{{ t('components.autonomy.feedbackStatsCard.totalActions', { count: total }) }}
			</p>
		</template>
	</UiCard>
</template>
