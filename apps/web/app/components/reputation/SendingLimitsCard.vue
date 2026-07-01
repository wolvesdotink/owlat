<script setup lang="ts">
import { formatNumber } from '~/utils/formatters';

const props = defineProps<{
	warming: {
		phase: string;
		totalDailyCap: number;
		totalSentToday: number;
		remainingToday: number;
		ipCount: number;
		ips: Array<{
			ip: string;
			phase: string;
			currentDay: number;
			dailyCap: number;
			sentToday: number;
			bounceRate: number;
			deferralRate: number;
			pool: string;
			active: boolean;
		}>;
		syncedAt: number;
	} | null;
	volume: {
		dailySendCount: number;
	};
	abuseStatus: string | null;
}>();

const phaseLabels: Record<string, string> = {
	ramp: 'Warming Up',
	plateau: 'Paused',
	graduated: 'Fully Warmed',
	unknown: 'Unknown',
};

const phaseColors: Record<string, string> = {
	ramp: 'bg-warning/10 text-warning',
	plateau: 'bg-error/10 text-error',
	graduated: 'bg-success/10 text-success',
	unknown: 'bg-bg-surface text-text-secondary',
};

const capacityPercent = computed(() => {
	if (!props.warming || props.warming.totalDailyCap === 0) return 0;
	return Math.min(100, Math.round((props.warming.totalSentToday / props.warming.totalDailyCap) * 100));
});

const capacityVariant = computed(() => {
	if (capacityPercent.value >= 90) return 'error' as const;
	if (capacityPercent.value >= 70) return 'warning' as const;
	return 'brand' as const;
});

const warmupProgressPercent = computed(() => {
	if (!props.warming?.ips?.length) return 0;
	const maxDay = Math.max(...props.warming.ips.map(ip => ip.currentDay));
	return Math.min(100, Math.round((maxDay / 30) * 100));
});

const abuseWarning = computed(() => {
	if (!props.abuseStatus || props.abuseStatus === 'clean') return null;
	switch (props.abuseStatus) {
		case 'warned':
			return { message: 'Your account has been flagged for elevated bounce or complaint rates. Improve your list quality to avoid further restrictions.', severity: 'warning' };
		case 'suspended':
			return { message: 'Your sending has been suspended due to critical reputation thresholds being exceeded.', severity: 'error' };
		case 'banned':
			return { message: 'Your account has been permanently restricted from sending.', severity: 'error' };
		default:
			return null;
	}
});

const lastSyncedLabel = computed(() => {
	if (!props.warming?.syncedAt) return null;
	return formatCompactRelativeTime(props.warming.syncedAt);
});
</script>

<template>
	<UiCard>
		<div class="space-y-6">
			<!-- Header -->
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<UiIconBox icon="lucide:flame" size="lg" variant="brand" rounded="xl" />
					<div>
						<h2 class="text-lg font-semibold text-text-primary">IP Warmup & Sending</h2>
						<p class="text-sm text-text-secondary">Your sending capacity based on IP reputation</p>
					</div>
				</div>
				<span
					v-if="warming"
					:class="phaseColors[warming.phase] ?? phaseColors['unknown']"
					class="px-3 py-1.5 rounded-full text-sm font-medium"
				>
					{{ phaseLabels[warming.phase] ?? warming.phase }}
				</span>
			</div>

			<!-- Abuse Warning -->
			<div
				v-if="abuseWarning"
				:class="abuseWarning.severity === 'error' ? 'bg-error/10 border-error/20 text-error' : 'bg-warning/10 border-warning/20 text-warning'"
				class="flex items-start gap-3 p-4 rounded-lg border"
			>
				<Icon
					:name="abuseWarning.severity === 'error' ? 'lucide:alert-triangle' : 'lucide:alert-circle'"
					class="w-5 h-5 mt-0.5 shrink-0"
				/>
				<p class="text-sm">{{ abuseWarning.message }}</p>
			</div>

			<!-- No warming data yet -->
			<div v-if="!warming" class="p-4 bg-bg-surface rounded-lg">
				<p class="text-sm text-text-secondary">
					Warming data is not available yet. IP warmup status will appear once your mail server starts sending.
				</p>
			</div>

			<!-- Warming data available -->
			<template v-else>
				<!-- Graduated / Fully Warmed -->
				<div v-if="warming.phase === 'graduated'" class="flex items-center gap-3 p-4 bg-success/10 border border-success/20 rounded-lg">
					<Icon name="lucide:check-circle" class="w-5 h-5 text-success shrink-0" />
					<div>
						<p class="text-sm font-medium text-success">All IPs Fully Warmed</p>
						<p class="text-sm text-text-secondary">Your sending IPs have graduated. Campaigns send at full speed.</p>
					</div>
				</div>

				<!-- Warmup Progress (not graduated) -->
				<div v-else>
					<div class="flex items-center justify-between mb-2">
						<p class="text-sm text-text-secondary">Warmup progress</p>
						<p class="text-sm font-medium text-text-primary">{{ warmupProgressPercent }}%</p>
					</div>
					<UiProgressBar :value="warmupProgressPercent" aria-label="IP warmup progress" />
					<p class="text-xs text-text-tertiary mt-1.5">
						Your sending capacity increases daily based on deliverability signals. Typically takes ~30 days to fully warm.
					</p>
				</div>

				<!-- Today's Sending Capacity -->
				<div>
					<div class="flex items-center justify-between mb-2">
						<p class="text-sm text-text-secondary">Today's sending capacity</p>
						<p class="text-sm font-medium text-text-primary">
							{{ formatNumber(warming.totalSentToday) }} / {{ formatNumber(warming.totalDailyCap) }} emails
						</p>
					</div>
					<UiProgressBar :value="capacityPercent" :variant="capacityVariant" aria-label="Daily capacity used" />
					<p class="text-xs text-text-tertiary mt-1.5">
						{{ warming.remainingToday.toLocaleString() }} emails remaining today. Resets at midnight UTC.
					</p>
				</div>

				<!-- Per-IP Details -->
				<div v-if="warming.ips.length > 0">
					<p class="text-sm font-medium text-text-primary mb-3">
						Sending IPs ({{ warming.ipCount }})
					</p>
					<div class="space-y-2">
						<div
							v-for="ip in warming.ips"
							:key="ip.ip"
							class="flex items-center justify-between p-3 bg-bg-surface rounded-lg"
						>
							<div class="flex items-center gap-3">
								<div
									class="w-2 h-2 rounded-full"
									:class="ip.active ? 'bg-success' : 'bg-error'"
								/>
								<div>
									<p class="text-sm font-mono text-text-primary">{{ ip.ip }}</p>
									<p class="text-xs text-text-tertiary">
										Day {{ ip.currentDay }} · {{ phaseLabels[ip.phase] ?? ip.phase }}
									</p>
								</div>
							</div>
							<div class="text-right">
								<p class="text-sm text-text-primary">
									{{ ip.sentToday.toLocaleString() }} / {{ ip.dailyCap.toLocaleString() }}
								</p>
								<p class="text-xs text-text-tertiary">
									{{ (ip.bounceRate * 100).toFixed(1) }}% bounce
								</p>
							</div>
						</div>
					</div>
				</div>
			</template>

			<!-- Volume Tracking -->
			<div class="pt-4 border-t border-border-subtle">
				<div class="flex items-center justify-between">
					<p class="text-sm text-text-secondary">Total emails sent today (all types)</p>
					<p class="text-sm font-medium text-text-primary">{{ volume.dailySendCount.toLocaleString() }}</p>
				</div>
				<p v-if="lastSyncedLabel" class="text-xs text-text-tertiary mt-2">
					Last synced: {{ lastSyncedLabel }}
				</p>
			</div>
		</div>
	</UiCard>
</template>
