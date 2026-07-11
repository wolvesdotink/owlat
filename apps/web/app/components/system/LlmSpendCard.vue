<script setup lang="ts">
import { api } from '@owlat/api';

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
			<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider">LLM spend · last 7 days</h3>
			<p class="text-2xl font-semibold text-text-primary">${{ (llmSpend?.totalCostUsd ?? 0).toFixed(2) }}</p>
		</div>
		<div v-if="llmSpend && llmSpend.features.length" class="space-y-2">
			<div
				v-for="f in llmSpend.features"
				:key="f.feature"
				class="flex items-center justify-between text-sm"
			>
				<span class="text-text-secondary">{{ f.feature }}</span>
				<span class="text-text-primary font-medium">
					${{ f.costUsd.toFixed(2) }}
					<span class="text-text-tertiary font-normal">· {{ f.calls }} calls</span>
				</span>
			</div>
		</div>
		<p v-else class="text-text-tertiary text-sm">No LLM usage recorded in the last 7 days.</p>

		<!-- Same spend, grouped by provider backend -->
		<div
			v-if="llmSpendByProvider && llmSpendByProvider.providers.length > 1"
			class="mt-4 pt-4 border-t border-border-default"
		>
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">By provider</p>
			<div class="space-y-2">
				<div
					v-for="p in llmSpendByProvider.providers"
					:key="p.provider"
					class="flex items-center justify-between text-sm"
				>
					<span class="text-text-secondary">{{ p.provider }}</span>
					<span class="text-text-primary font-medium">
						${{ p.costUsd.toFixed(2) }}
						<span class="text-text-tertiary font-normal">· {{ p.calls }} calls</span>
					</span>
				</div>
			</div>
		</div>

		<!-- Spend budget: remaining headroom + warn / paused state -->
		<div v-if="spendBudget?.configured" class="mt-4 pt-4 border-t border-border-default space-y-2">
			<div class="flex items-baseline justify-between gap-2 flex-wrap">
				<h4 class="text-xs font-medium text-text-tertiary uppercase tracking-wider">Spend budget</h4>
				<span
					v-if="spendBudget.state !== 'ok'"
					class="text-2xs font-medium px-2 py-0.5 rounded-full"
					:class="spendBudget.state === 'exceeded'
						? 'bg-red-500/15 text-red-500'
						: 'bg-amber-500/15 text-amber-500'"
				>
					{{ spendBudget.state === 'exceeded' ? 'Ceiling reached — auto-send paused' : 'Approaching ceiling' }}
				</span>
			</div>
			<div v-if="spendBudget.daily.configured" class="flex items-center justify-between text-sm">
				<span class="text-text-secondary">Daily remaining</span>
				<span class="text-text-primary font-medium">
					${{ spendBudget.daily.remainingUsd.toFixed(2) }}
					<span class="text-text-tertiary font-normal">of ${{ spendBudget.daily.limitUsd.toFixed(2) }}</span>
				</span>
			</div>
			<div v-if="spendBudget.monthly.configured" class="flex items-center justify-between text-sm">
				<span class="text-text-secondary">Monthly remaining</span>
				<span class="text-text-primary font-medium">
					${{ spendBudget.monthly.remainingUsd.toFixed(2) }}
					<span class="text-text-tertiary font-normal">of ${{ spendBudget.monthly.limitUsd.toFixed(2) }}</span>
				</span>
			</div>
			<p v-if="!spendBudget.advisoryAllowed" class="text-text-tertiary text-xs">
				Advisory AI is paused; the remaining budget is reserved for autonomous replies.
			</p>
		</div>
	</div>
</template>
