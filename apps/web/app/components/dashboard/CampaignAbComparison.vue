<script setup lang="ts">
/**
 * CampaignAbComparison — the A/B fold-in inside a campaign report. Two-column
 * variant comparison with a single roll-up status chip, a winner state, and a
 * "Pick winner" action for undecided manual tests. Purely presentational: the
 * page owns the mutation and passes `isSelectingWinner` + listens for
 * `select-winner`. (Replaces the standalone /campaigns/ab-results surface.)
 */

/** One variant's reduced stats (shape of `computeAbVariantStats`). */
interface VariantStats {
	sent: number;
	delivered: number;
	opened: number;
	clicked: number;
	openRate: number;
	clickRate: number;
}

/** A/B stats shape (mirror of `api.campaigns.abTest.getABTestStats`, non-null). */
interface AbStats {
	status: 'pending' | 'testing' | 'winner_selected' | undefined;
	winner: 'A' | 'B' | undefined;
	winnerSelectedAt: number | undefined;
	config: {
		testType?: 'subject' | 'content';
		winnerCriteria?: 'open_rate' | 'click_rate' | 'manual';
	} | null;
	variantA: VariantStats;
	variantB: VariantStats;
}

const props = defineProps<{
	stats: AbStats;
	isSelectingWinner: boolean;
}>();

const emit = defineEmits<{
	'select-winner': [winner: 'A' | 'B'];
}>();

const testTypeLabel = computed(() =>
	props.stats.config?.testType === 'content' ? 'Email content' : 'Subject lines'
);

const showManualPicker = computed(
	() =>
		props.stats.config?.winnerCriteria === 'manual' &&
		!props.stats.winner &&
		props.stats.status === 'testing'
);

const criteriaLabel = computed(() => {
	switch (props.stats.config?.winnerCriteria) {
		case 'open_rate':
			return 'best open rate';
		case 'click_rate':
			return 'best click rate';
		default:
			return 'manual selection';
	}
});

// How much better the winner was, on the deciding metric — ported from the old
// ab-results list so the fold-in keeps that at-a-glance summary.
const winnerDifference = computed(() => {
	const { winner, config, variantA, variantB } = props.stats;
	if (!winner) return null;
	const winnerStats = winner === 'A' ? variantA : variantB;
	const loserStats = winner === 'A' ? variantB : variantA;
	const criteria = config?.winnerCriteria ?? 'open_rate';
	if (criteria === 'click_rate') {
		return {
			metric: 'click rate',
			diff: (winnerStats.clickRate - loserStats.clickRate).toFixed(1),
		};
	}
	return { metric: 'open rate', diff: (winnerStats.openRate - loserStats.openRate).toFixed(1) };
});

const variants = computed(() => [
	{ key: 'A' as const, stats: props.stats.variantA },
	{ key: 'B' as const, stats: props.stats.variantB },
]);
</script>

<template>
	<div class="card p-6" data-testid="ab-comparison">
		<div class="flex items-center justify-between gap-4 mb-6">
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:split" size="sm" rounded="lg" />
				<div>
					<h3 class="text-base font-medium text-text-primary">A/B test</h3>
					<p class="text-sm text-text-secondary">Testing {{ testTypeLabel }}</p>
				</div>
			</div>
			<!-- One roll-up status chip per the FF one-chip rule. -->
			<span
				v-if="stats.winner"
				class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-success/10 text-success"
				data-testid="ab-winner-chip"
			>
				<Icon name="lucide:trophy" class="w-3.5 h-3.5" />
				Variant {{ stats.winner }} won
			</span>
			<span
				v-else-if="stats.status === 'testing'"
				class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-warning/10 text-warning"
				data-testid="ab-testing-chip"
			>
				<Icon name="lucide:clock" class="w-3.5 h-3.5" />
				Testing in progress
			</span>
		</div>

		<!-- Variant comparison -->
		<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
			<div
				v-for="variant in variants"
				:key="variant.key"
				:class="[
					'p-4 border rounded-lg transition-colors duration-(--motion-moderate)',
					stats.winner === variant.key ? 'border-brand bg-brand/5' : 'border-border-subtle',
				]"
				data-testid="ab-variant"
			>
				<div class="flex items-center justify-between mb-4">
					<div class="flex items-center gap-2">
						<div
							class="w-8 h-8 rounded-full bg-brand/15 text-brand flex items-center justify-center font-semibold"
						>
							{{ variant.key }}
						</div>
						<span
							:class="[
								'text-text-primary',
								stats.winner === variant.key ? 'font-semibold' : 'font-medium',
							]"
							>Variant {{ variant.key }}</span
						>
						<Icon
							v-if="stats.winner === variant.key"
							name="lucide:trophy"
							class="w-4 h-4 text-success"
						/>
					</div>
					<span class="text-sm text-text-tertiary tabular-nums">
						{{ variant.stats.sent.toLocaleString() }} sent
					</span>
				</div>
				<div class="space-y-3">
					<div class="flex justify-between items-center">
						<span class="text-sm text-text-secondary">Open rate</span>
						<span class="text-sm font-medium text-text-primary tabular-nums"
							>{{ variant.stats.openRate.toFixed(1) }}%</span
						>
					</div>
					<div class="h-1.5 bg-bg-surface rounded-full overflow-hidden">
						<div
							class="h-full bg-brand rounded-full"
							:style="{ width: `${Math.min(variant.stats.openRate, 100)}%` }"
						/>
					</div>
					<div class="flex justify-between items-center">
						<span class="text-sm text-text-secondary">Click rate</span>
						<span class="text-sm font-medium text-text-primary tabular-nums"
							>{{ variant.stats.clickRate.toFixed(1) }}%</span
						>
					</div>
					<div class="h-1.5 bg-bg-surface rounded-full overflow-hidden">
						<div
							class="h-full bg-brand rounded-full"
							:style="{ width: `${Math.min(variant.stats.clickRate, 100)}%` }"
						/>
					</div>
				</div>
			</div>
		</div>

		<!-- Manual winner selection (manual criteria, still testing) -->
		<div v-if="showManualPicker" class="border-t border-border-subtle pt-4">
			<p class="text-sm text-text-secondary mb-3">
				Pick the winning variant to send to the rest of the audience.
			</p>
			<div class="flex gap-3">
				<button
					v-for="variant in variants"
					:key="variant.key"
					class="btn btn-secondary gap-2 flex-1"
					:disabled="isSelectingWinner"
					data-testid="ab-pick-winner"
					@click="emit('select-winner', variant.key)"
				>
					<Icon v-if="isSelectingWinner" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
					<Icon v-else name="lucide:trophy" class="w-4 h-4" />
					Pick variant {{ variant.key }}
				</button>
			</div>
		</div>

		<!-- Winner summary -->
		<div
			v-else-if="stats.winner && winnerDifference"
			class="border-t border-border-subtle pt-4 flex items-center gap-2 text-sm text-text-secondary"
			data-testid="ab-winner-summary"
		>
			<Icon name="lucide:check-circle-2" class="w-4 h-4 text-success shrink-0" />
			<span>
				Variant {{ stats.winner }} won with
				<span class="font-medium text-text-primary tabular-nums"
					>+{{ winnerDifference.diff }} pts</span
				>
				higher {{ winnerDifference.metric
				}}<template v-if="stats.winnerSelectedAt">
					· picked by {{ criteriaLabel }} {{ formatDateTime(stats.winnerSelectedAt) }}</template
				>.
			</span>
		</div>
	</div>
</template>
