<script setup lang="ts">
/**
 * Band 3 of the Marketing overview: Needs you, Scheduled, Drafts. Always the
 * last band — it is only the whole page before the first send. Every row links
 * to the campaign (the report for an A/B decision, the editor otherwise).
 */
import type { NextUpRow } from '~/composables/useMarketingNextUp';
import { formatDateTime, formatRelativeTime } from '~/utils/formatters';

defineProps<{
	needsYou: readonly NextUpRow[];
	scheduled: readonly NextUpRow[];
	scheduledTotal: number;
	drafts: readonly NextUpRow[];
}>();

const { t } = useI18n();
</script>

<template>
	<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
		<!-- Needs you -->
		<section class="card p-5" aria-labelledby="next-up-needs-you">
			<h3
				id="next-up-needs-you"
				class="flex items-center gap-2 text-sm font-medium text-text-primary"
			>
				{{ t('components.marketing.nextUp.needsYou') }}
				<span class="text-xs tabular-nums text-text-tertiary">{{ needsYou.length }}</span>
			</h3>
			<p v-if="needsYou.length === 0" class="mt-3 text-sm text-text-tertiary">
				{{ t('components.marketing.nextUp.needsYouEmpty') }}
			</p>
			<ul v-else class="mt-3 divide-y divide-border-subtle">
				<li v-for="row in needsYou" :key="row.id">
					<NuxtLink
						:to="row.href"
						class="flex items-start justify-between gap-3 py-2.5 group focus-visible:outline-2 focus-visible:outline-brand rounded"
					>
						<div class="min-w-0">
							<p class="text-sm text-text-primary truncate group-hover:underline">{{ row.name }}</p>
							<p
								:class="[
									'mt-0.5 text-xs inline-flex items-center gap-1',
									row.isUrgent ? 'text-warning' : 'text-text-tertiary',
								]"
							>
								<Icon
									v-if="row.isUrgent"
									name="lucide:alert-triangle"
									class="w-3 h-3"
									aria-hidden="true"
								/>
								<template v-if="row.isUrgent && row.scheduledAt">
									{{
										t('components.marketing.nextUp.reviewBefore', {
											date: formatDateTime(row.scheduledAt),
										})
									}}
								</template>
								<template v-else-if="row.chipLabel">{{ t(row.chipLabel) }}</template>
							</p>
						</div>
						<span v-if="row.actionLabel" class="shrink-0 text-xs font-medium text-brand">
							{{ t(row.actionLabel) }}
						</span>
					</NuxtLink>
				</li>
			</ul>
		</section>

		<!-- Scheduled -->
		<section class="card p-5" aria-labelledby="next-up-scheduled">
			<h3
				id="next-up-scheduled"
				class="flex items-center gap-2 text-sm font-medium text-text-primary"
			>
				{{ t('components.marketing.nextUp.scheduled') }}
				<span class="text-xs tabular-nums text-text-tertiary">{{ scheduledTotal }}</span>
			</h3>
			<p v-if="scheduled.length === 0" class="mt-3 text-sm text-text-tertiary">
				{{ t('components.marketing.nextUp.scheduledEmpty') }}
			</p>
			<ul v-else class="mt-3 divide-y divide-border-subtle">
				<li v-for="row in scheduled" :key="row.id">
					<NuxtLink
						:to="row.href"
						class="block py-2.5 group focus-visible:outline-2 focus-visible:outline-brand rounded"
					>
						<p class="text-sm text-text-primary truncate group-hover:underline">{{ row.name }}</p>
						<p class="mt-0.5 text-xs text-text-tertiary tabular-nums">
							{{
								row.scheduledAt
									? formatDateTime(row.scheduledAt)
									: t('components.marketing.nextUp.noTime')
							}}
						</p>
					</NuxtLink>
				</li>
			</ul>
			<NuxtLink
				v-if="scheduledTotal > scheduled.length"
				to="/dashboard/campaigns?status=scheduled"
				class="mt-2 inline-block text-xs text-brand hover:underline"
			>
				{{ t('components.marketing.nextUp.showAllScheduled', { count: scheduledTotal }) }}
			</NuxtLink>
		</section>

		<!-- Drafts -->
		<section class="card p-5" aria-labelledby="next-up-drafts">
			<h3 id="next-up-drafts" class="text-sm font-medium text-text-primary">
				{{ t('components.marketing.nextUp.drafts') }}
			</h3>
			<p v-if="drafts.length === 0" class="mt-3 text-sm text-text-tertiary">
				{{ t('components.marketing.nextUp.draftsEmpty') }}
			</p>
			<ul v-else class="mt-3 divide-y divide-border-subtle">
				<li v-for="row in drafts" :key="row.id">
					<NuxtLink
						:to="row.href"
						class="block py-2.5 group focus-visible:outline-2 focus-visible:outline-brand rounded"
					>
						<p class="text-sm text-text-primary truncate group-hover:underline">{{ row.name }}</p>
						<p class="mt-0.5 text-xs text-text-tertiary">
							{{
								t('components.marketing.nextUp.edited', { when: formatRelativeTime(row.updatedAt) })
							}}
						</p>
					</NuxtLink>
				</li>
			</ul>
			<NuxtLink
				v-if="drafts.length > 0"
				to="/dashboard/campaigns?status=draft"
				class="mt-2 inline-block text-xs text-brand hover:underline"
			>
				{{ t('components.marketing.nextUp.showAllDrafts') }}
			</NuxtLink>
		</section>
	</div>
</template>
