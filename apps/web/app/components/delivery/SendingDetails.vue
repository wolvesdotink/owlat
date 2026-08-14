<script setup lang="ts">
/** Operator-facing outbound identity, pool, warming, and DNSBL status. */
import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import { DNSBL_LISTS } from '@owlat/shared/dnsbl';
import { formatNumber, formatCompactRelativeTime } from '~/utils/formatters';
import { healthChipClass, healthDotClass } from '~/utils/healthTone';
import { outboundIpPresentation } from '~/utils/outboundIpStatus';

type Overview = NonNullable<
	FunctionReturnType<typeof api.analytics.reputationQueries.getSendingOverview>
>;

const props = defineProps<{
	warming: Overview['warming'];
	volume: Overview['volume'];
}>();

const { t } = useI18n();

/**
 * The per-IP verdict comes out of `utils/outboundIpStatus`, a module-scope
 * definition set that carries i18n keys rather than sentences (the registry
 * convention); a plain string is still accepted so a value with nothing to
 * translate reads as itself.
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

const ips = computed(() =>
	(props.warming?.ips ?? []).map((ip) => ({
		...ip,
		presentation: outboundIpPresentation(ip),
		dnsblDefinitions: (ip.dnsblListings ?? []).map((id) => DNSBL_LISTS[id]),
	}))
);
const lastSynced = computed(() =>
	props.warming ? formatCompactRelativeTime(props.warming.syncedAt) : null
);

const DOCS_BASE = 'https://docs.owlat.app';
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="flex items-start justify-between gap-4 px-5 py-4 border-b border-border-subtle">
			<div>
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('components.delivery.sendingDetails.title') }}
				</h2>
				<p class="text-sm text-text-secondary mt-0.5">
					{{ t('components.delivery.sendingDetails.subtitle') }}
				</p>
			</div>
			<span v-if="lastSynced" class="text-xs text-text-tertiary shrink-0">
				{{ t('components.delivery.sendingDetails.synced', { relativeTime: lastSynced }) }}
			</span>
		</div>

		<div v-if="ips.length === 0" class="px-5 py-5 text-sm text-text-secondary">
			{{ t('components.delivery.sendingDetails.empty') }}
		</div>

		<div v-else class="divide-y divide-border-subtle">
			<section v-for="ip in ips" :key="ip.ip" class="px-5 py-4 space-y-3">
				<div class="flex items-start justify-between gap-4">
					<div class="flex items-start gap-2.5 min-w-0">
						<span
							class="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0"
							:class="healthDotClass[ip.presentation.tone]"
							aria-hidden="true"
						/>
						<div class="min-w-0">
							<p class="font-mono text-sm text-text-primary truncate">{{ ip.ip }}</p>
							<p class="text-xs text-text-tertiary mt-0.5">
								{{
									t('components.delivery.sendingDetails.ipMeta', {
										pool: ip.pool,
										day: ip.currentDay,
										sent: formatNumber(ip.sentToday),
										cap: formatNumber(ip.dailyCap),
									})
								}}
							</p>
						</div>
					</div>
					<span
						class="px-2.5 py-1 rounded-full text-xs font-medium shrink-0"
						:class="healthChipClass[ip.presentation.tone]"
					>
						{{ localized(ip.presentation.label) }}
					</span>
				</div>

				<div class="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<p class="text-xs text-text-tertiary">
							{{ t('components.delivery.sendingDetails.ptrRecord') }}
						</p>
						<p class="font-mono text-text-primary break-all mt-0.5">
							{{
								ip.fcrdns?.ptrNames.join(', ') || t('components.delivery.sendingDetails.notFound')
							}}
						</p>
					</div>
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<p class="text-xs text-text-tertiary">
							{{ t('components.delivery.sendingDetails.ehloHostname') }}
						</p>
						<p class="font-mono text-text-primary break-all mt-0.5">
							{{ ip.fcrdns?.ehlo || t('components.delivery.sendingDetails.notReported') }}
						</p>
					</div>
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<p class="text-xs text-text-tertiary">
							{{ t('components.delivery.sendingDetails.blocklists') }}
						</p>
						<p class="text-text-primary mt-0.5 capitalize">
							{{ ip.dnsbl || t('common.unknown') }}
							<span v-if="ip.dnsblDefinitions.length > 0">
								·
								{{ ip.dnsblDefinitions.map((list) => list.name).join(', ') }}
							</span>
						</p>
					</div>
				</div>

				<div
					class="rounded-lg border px-3 py-2.5 text-sm"
					:class="
						ip.presentation.tone === 'error'
							? 'border-error/20 bg-error/10 text-error'
							: ip.presentation.tone === 'warning'
								? 'border-warning/20 bg-warning/10 text-warning'
								: 'border-success/20 bg-success/10 text-success'
					"
				>
					<p>{{ localized(ip.presentation.detail) }}</p>
					<p v-if="ip.presentation.remediation" class="mt-1">
						{{ localized(ip.presentation.remediation) }}
						<template v-if="ip.blockReasons?.includes('fcrdns')">
							<I18nT
								keypath="components.delivery.sendingDetails.ptrRemediation"
								tag="span"
								scope="global"
							>
								<template #ehlo>
									<code class="font-mono">{{ ip.fcrdns?.ehlo }}</code>
								</template>
							</I18nT>
						</template>
					</p>
					<div v-if="ip.dnsblDefinitions.length > 0" class="mt-2 flex flex-wrap gap-2">
						<a
							v-for="list in ip.dnsblDefinitions"
							:key="list.id"
							:href="`${DOCS_BASE}${list.runbookPath}`"
							target="_blank"
							rel="noopener"
							class="inline-flex items-center gap-1 font-medium underline underline-offset-2"
						>
							{{
								t('components.delivery.sendingDetails.recoverySteps', { blocklist: list.name })
							}}
							<Icon name="lucide:external-link" class="w-3 h-3" />
						</a>
					</div>
				</div>
			</section>
		</div>

		<div
			class="flex items-center justify-between gap-3 px-5 py-3 bg-bg-surface border-t border-border-subtle"
		>
			<p class="text-sm text-text-secondary">
				{{ t('components.delivery.sendingDetails.totalSentToday') }}
			</p>
			<p class="text-sm font-medium text-text-primary tabular-nums">
				{{ formatNumber(volume.dailySendCount) }}
			</p>
		</div>
	</UiCard>
</template>
