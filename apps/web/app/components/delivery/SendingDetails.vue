<script setup lang="ts">
/**
 * Depth-on-demand for the health page's warm-up summary. The header line and the
 * budget tile say where warm-up stands at a glance; this collapsed disclosure
 * keeps the fuller operational detail one interaction away — per-IP warm-up
 * state (IP, day, cap/sent, bounce, active), total emails sent today across all
 * types, and when the MTA last synced. Summary first, detail one click away — no
 * second focal point on the doing-surface.
 */
import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import { formatNumber, formatPercentage, formatCompactRelativeTime } from '~/utils/formatters';
import { healthDotClass } from '~/utils/healthTone';

type Overview = NonNullable<
	FunctionReturnType<typeof api.analytics.reputationQueries.getSendingOverview>
>;

const props = defineProps<{
	warming: Overview['warming'];
	volume: Overview['volume'];
}>();

const open = ref(false);

const ips = computed(() => props.warming?.ips ?? []);
const lastSynced = computed(() =>
	props.warming ? formatCompactRelativeTime(props.warming.syncedAt) : null
);
</script>

<template>
	<div class="rounded-lg border border-border-subtle">
		<button
			type="button"
			class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left rounded-lg hover:bg-bg-surface-hover outline-none focus-visible:ring-1 focus-visible:ring-brand/40 transition-colors duration-(--motion-fast)"
			:aria-expanded="open"
			@click="open = !open"
		>
			<span class="text-sm font-medium text-text-primary">Sending details</span>
			<Icon
				name="lucide:chevron-down"
				class="w-4 h-4 text-text-tertiary transition-transform duration-(--motion-moderate)"
				:class="open ? 'rotate-180' : ''"
			/>
		</button>

		<div v-if="open" class="border-t border-border-subtle px-4 py-4 space-y-4">
			<!-- Per-IP warm-up detail -->
			<div v-if="ips.length > 0">
				<p class="text-xs uppercase tracking-wide text-text-tertiary mb-2">
					Sending IPs ({{ warming?.ipCount ?? ips.length }})
				</p>
				<div class="divide-y divide-border-subtle">
					<div
						v-for="ip in ips"
						:key="ip.ip"
						class="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
					>
						<div class="flex items-center gap-2.5 min-w-0">
							<span
								class="w-2 h-2 rounded-full shrink-0"
								:class="healthDotClass[ip.active ? 'success' : 'error']"
								aria-hidden="true"
							/>
							<div class="min-w-0">
								<p class="text-sm font-mono text-text-primary truncate">{{ ip.ip }}</p>
								<p class="text-xs text-text-tertiary">Day {{ ip.currentDay }} · {{ ip.phase }}</p>
							</div>
						</div>
						<div class="text-right shrink-0 tabular-nums">
							<p class="text-sm text-text-primary">
								{{ formatNumber(ip.sentToday) }} / {{ formatNumber(ip.dailyCap) }}
							</p>
							<p class="text-xs text-text-tertiary">
								{{ formatPercentage(ip.bounceRate, 1) }} bounce
							</p>
						</div>
					</div>
				</div>
			</div>

			<!-- Volume + last-synced -->
			<div class="flex items-center justify-between gap-3 pt-3 border-t border-border-subtle">
				<p class="text-sm text-text-secondary">Total emails sent today (all types)</p>
				<p class="text-sm font-medium text-text-primary tabular-nums">
					{{ formatNumber(volume.dailySendCount) }}
				</p>
			</div>
			<p v-if="lastSynced" class="text-xs text-text-tertiary">Last synced {{ lastSynced }}</p>
		</div>
	</div>
</template>
