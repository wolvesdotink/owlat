<script setup lang="ts">
import { api } from '@owlat/api';

const { t, locale } = useI18n();

// Amounts are recorded in USD; the formatting follows the active locale.
const formatUsd = (value: number) =>
	new Intl.NumberFormat(locale.value, { style: 'currency', currency: 'USD' }).format(value);

// Deployment-wide LLM spend, broken down by feature (last 7 days). The data was
// recorded by every priced LLM call but had no UI surface until now.
const { data: llmSpend } = useOrganizationQuery(
	api.analytics.llmUsage.getSpendByFeature,
	() => ({ hoursBack: 168 }),
);

// The SAME spend, grouped by provider backend (OpenAI / Anthropic / Google /
// OpenRouter / Local), derived from each call's recorded model id — so spend
// reads correctly per backend after a provider switch or split.
const { data: llmSpendByProvider } = useOrganizationQuery(
	api.analytics.llmUsage.getSpendByProvider,
	() => ({ hoursBack: 168 }),
);

// Per-org dollar-spend budget: remaining daily/monthly headroom + warn state.
// When a ceiling is hit the autonomous path degrades to draft-only and advisory
// AI is paused (analytics/spendBudget.ts). Unset ceilings ⇒ `configured: false`.
const { data: spendBudget } = useOrganizationQuery(
	api.analytics.spendBudget.getBudgetStatusAdmin,
	() => ({}),
);
</script>

<template>
	<div class="rounded-xl border border-border-default bg-bg-elevated p-6">
		<div class="flex items-baseline justify-between gap-4 flex-wrap mb-4">
			<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider">{{ t('components.system.llmSpendCard.title') }}</h3>
			<p class="text-2xl font-medium tracking-[-0.02em] text-text-primary">{{ formatUsd(llmSpend?.totalCostUsd ?? 0) }}</p>
		</div>
		<div v-if="llmSpend && llmSpend.features.length" class="space-y-2">
			<div
				v-for="f in llmSpend.features"
				:key="f.feature"
				class="flex items-center justify-between text-sm"
			>
				<span class="text-text-secondary">{{ f.feature }}</span>
				<span class="text-text-primary font-medium">
					{{ formatUsd(f.costUsd) }}
					<span class="text-text-tertiary font-normal">{{ t('components.system.llmSpendCard.calls', { count: f.calls }) }}</span>
				</span>
			</div>
		</div>
		<p v-else class="text-text-tertiary text-sm">{{ t('components.system.llmSpendCard.noUsage') }}</p>

		<!-- Same spend, grouped by provider backend -->
		<div
			v-if="llmSpendByProvider && llmSpendByProvider.providers.length > 1"
			class="mt-4 pt-4 border-t border-border-default"
		>
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">{{ t('components.system.llmSpendCard.byProvider') }}</p>
			<div class="space-y-2">
				<div
					v-for="p in llmSpendByProvider.providers"
					:key="p.provider"
					class="flex items-center justify-between text-sm"
				>
					<span class="text-text-secondary">{{ p.provider }}</span>
					<span class="text-text-primary font-medium">
						{{ formatUsd(p.costUsd) }}
						<span class="text-text-tertiary font-normal">{{ t('components.system.llmSpendCard.calls', { count: p.calls }) }}</span>
					</span>
				</div>
			</div>
		</div>

		<!-- Spend budget: remaining headroom + warn / paused state -->
		<div v-if="spendBudget?.configured" class="mt-4 pt-4 border-t border-border-default space-y-2">
			<div class="flex items-baseline justify-between gap-2 flex-wrap">
				<h4 class="text-xs font-medium text-text-tertiary uppercase tracking-wider">{{ t('components.system.llmSpendCard.spendBudget') }}</h4>
				<span
					v-if="spendBudget.state !== 'ok'"
					class="text-2xs font-medium px-2 py-0.5 rounded-full"
					:class="spendBudget.state === 'exceeded'
						? 'bg-error/10 text-error'
						: 'bg-warning/10 text-warning'"
				>
					{{ spendBudget.state === 'exceeded' ? t('components.system.llmSpendCard.ceilingReached') : t('components.system.llmSpendCard.approachingCeiling') }}
				</span>
			</div>
			<div v-if="spendBudget.daily.configured" class="flex items-center justify-between text-sm">
				<span class="text-text-secondary">{{ t('components.system.llmSpendCard.dailyRemaining') }}</span>
				<span class="text-text-primary font-medium">
					{{ formatUsd(spendBudget.daily.remainingUsd) }}
					<span class="text-text-tertiary font-normal">{{ t('components.system.llmSpendCard.ofLimit', { amount: formatUsd(spendBudget.daily.limitUsd) }) }}</span>
				</span>
			</div>
			<div v-if="spendBudget.monthly.configured" class="flex items-center justify-between text-sm">
				<span class="text-text-secondary">{{ t('components.system.llmSpendCard.monthlyRemaining') }}</span>
				<span class="text-text-primary font-medium">
					{{ formatUsd(spendBudget.monthly.remainingUsd) }}
					<span class="text-text-tertiary font-normal">{{ t('components.system.llmSpendCard.ofLimit', { amount: formatUsd(spendBudget.monthly.limitUsd) }) }}</span>
				</span>
			</div>
			<p v-if="!spendBudget.advisoryAllowed" class="text-text-tertiary text-xs">
				{{ t('components.system.llmSpendCard.advisoryPaused') }}
			</p>
		</div>
	</div>
</template>
