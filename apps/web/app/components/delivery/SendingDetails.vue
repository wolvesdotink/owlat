<script setup lang="ts">
/** Operator-facing outbound identity, pool, warming, and DNSBL status. */
import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import { formatNumber, formatCompactRelativeTime } from '~/utils/formatters';
import { healthChipClass, healthDotClass } from '~/utils/healthTone';
import { outboundIpPresentation } from '~/utils/outboundIpStatus';

type Overview = NonNullable<
	FunctionReturnType<typeof api.analytics.reputationQueries.getSendingOverview>
>;
type OutboundIp = NonNullable<Overview['warming']>['ips'][number];

const props = defineProps<{
	warming: Overview['warming'];
	volume: Overview['volume'];
}>();

const ips = computed(() => props.warming?.ips ?? []);
const lastSynced = computed(() =>
	props.warming ? formatCompactRelativeTime(props.warming.syncedAt) : null
);

function status(ip: OutboundIp) {
	return outboundIpPresentation(ip);
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="flex items-start justify-between gap-4 px-5 py-4 border-b border-border-subtle">
			<div>
				<h2 class="text-lg font-semibold text-text-primary">Outbound IPs</h2>
				<p class="text-sm text-text-secondary mt-0.5">
					The identities recipient mail servers see when Owlat delivers directly.
				</p>
			</div>
			<span v-if="lastSynced" class="text-xs text-text-tertiary shrink-0">
				Synced {{ lastSynced }}
			</span>
		</div>

		<div v-if="ips.length === 0" class="px-5 py-5 text-sm text-text-secondary">
			No outbound IP status has synced from the MTA yet.
		</div>

		<div v-else class="divide-y divide-border-subtle">
			<section v-for="ip in ips" :key="ip.ip" class="px-5 py-4 space-y-3">
				<div class="flex items-start justify-between gap-4">
					<div class="flex items-start gap-2.5 min-w-0">
						<span
							class="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0"
							:class="healthDotClass[status(ip).tone]"
							aria-hidden="true"
						/>
						<div class="min-w-0">
							<p class="font-mono text-sm text-text-primary truncate">{{ ip.ip }}</p>
							<p class="text-xs text-text-tertiary mt-0.5">
								{{ ip.pool }} pool · warm-up day {{ ip.currentDay }} ·
								{{ formatNumber(ip.sentToday) }} / {{ formatNumber(ip.dailyCap) }} today
							</p>
						</div>
					</div>
					<span
						class="px-2.5 py-1 rounded-full text-xs font-medium shrink-0"
						:class="healthChipClass[status(ip).tone]"
					>
						{{ status(ip).label }}
					</span>
				</div>

				<div class="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<p class="text-xs text-text-tertiary">PTR record</p>
						<p class="font-mono text-text-primary break-all mt-0.5">
							{{ ip.fcrdns?.ptrNames.join(', ') || 'Not found' }}
						</p>
					</div>
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<p class="text-xs text-text-tertiary">EHLO hostname</p>
						<p class="font-mono text-text-primary break-all mt-0.5">
							{{ ip.fcrdns?.ehlo || 'Not reported' }}
						</p>
					</div>
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<p class="text-xs text-text-tertiary">Blocklists</p>
						<p class="text-text-primary mt-0.5 capitalize">{{ ip.dnsbl || 'unknown' }}</p>
					</div>
				</div>

				<div
					class="rounded-lg border px-3 py-2.5 text-sm"
					:class="
						status(ip).tone === 'error'
							? 'border-error/20 bg-error/10 text-error'
							: status(ip).tone === 'warning'
								? 'border-warning/20 bg-warning/10 text-warning'
								: 'border-success/20 bg-success/10 text-success'
					"
				>
					<p>{{ status(ip).detail }}</p>
					<p v-if="status(ip).remediation" class="mt-1">
						{{ status(ip).remediation }} Set the PTR value to
						<code class="font-mono">{{ ip.fcrdns?.ehlo }}</code
						>, then wait for DNS to update.
					</p>
				</div>
			</section>
		</div>

		<div
			class="flex items-center justify-between gap-3 px-5 py-3 bg-bg-surface border-t border-border-subtle"
		>
			<p class="text-sm text-text-secondary">Total emails sent today (all types)</p>
			<p class="text-sm font-medium text-text-primary tabular-nums">
				{{ formatNumber(volume.dailySendCount) }}
			</p>
		</div>
	</UiCard>
</template>
