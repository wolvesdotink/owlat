<script setup lang="ts">
/**
 * Who sent mail as the domain, grouped by organisation, failing sources first.
 *
 * Each row is one organisation (Owlat's own server, a known sender such as
 * Google or Amazon SES, or an unknown host / IP), with its volume, how much of
 * it passed DMARC, and which check carried it. The backend already sorted the
 * list; this only renders it.
 */
import {
	formatPassRate,
	passRateTone,
	sourceKindKey,
	sourceKindVariant,
	sourcePassRate,
	type DmarcSourceKind,
} from '~/utils/dmarcReportView';
import { healthTextClass } from '~/utils/healthTone';
import { formatNumber } from '~/utils/formatters';

export interface DmarcSourceRow {
	key: string;
	kind: DmarcSourceKind;
	label: string;
	messageCount: number;
	alignedCount: number;
	failingCount: number;
	dkimAlignedCount: number;
	spfAlignedCount: number;
	ipCount: number;
	topIps: string[];
	overrideReasons: string[];
}

defineProps<{
	sources: readonly DmarcSourceRow[];
	totalCount: number;
}>();

const { t, locale } = useI18n();

function sourceLabel(source: DmarcSourceRow): string {
	return source.kind === 'owlat' ? t('components.delivery.dmarcSources.ownServer') : source.label;
}

function checksLine(source: DmarcSourceRow): string {
	return t('components.delivery.dmarcSources.checks', {
		dkim: formatNumber(source.dkimAlignedCount, locale.value),
		spf: formatNumber(source.spfAlignedCount, locale.value),
	});
}
</script>

<template>
	<div>
		<p
			v-if="sources.length === 0"
			class="rounded-lg bg-bg-surface px-3 py-3 text-sm text-text-secondary"
			data-testid="dmarc-sources-empty"
		>
			{{ t('components.delivery.dmarcSources.empty') }}
		</p>
		<div v-else class="overflow-x-auto">
			<table class="w-full text-sm" data-testid="dmarc-sources">
				<thead>
					<tr class="text-left text-xs uppercase tracking-wide text-text-tertiary">
						<th scope="col" class="py-2 pr-3 font-medium">
							{{ t('components.delivery.dmarcSources.columns.source') }}
						</th>
						<th scope="col" class="py-2 px-3 text-right font-medium">
							{{ t('components.delivery.dmarcSources.columns.messages') }}
						</th>
						<th scope="col" class="py-2 px-3 text-right font-medium">
							{{ t('components.delivery.dmarcSources.columns.passRate') }}
						</th>
						<th scope="col" class="py-2 pl-3 text-right font-medium">
							{{ t('components.delivery.dmarcSources.columns.failing') }}
						</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border-subtle">
					<tr
						v-for="source in sources"
						:key="source.key"
						class="align-top"
						data-testid="dmarc-source"
					>
						<td class="py-3 pr-3">
							<div class="flex flex-wrap items-center gap-2">
								<span class="font-medium text-text-primary break-all">{{
									sourceLabel(source)
								}}</span>
								<UiBadge :variant="sourceKindVariant(source.kind)" pill>
									{{ t(sourceKindKey(source.kind)) }}
								</UiBadge>
							</div>
							<p class="mt-0.5 text-xs text-text-tertiary">
								{{
									t(
										'components.delivery.dmarcSources.ips',
										{ ips: source.topIps.join(', '), count: source.ipCount },
										source.ipCount
									)
								}}
								· {{ checksLine(source) }}
							</p>
							<p v-if="source.overrideReasons.length > 0" class="mt-0.5 text-xs text-text-tertiary">
								{{
									t('components.delivery.dmarcSources.reasons', {
										reasons: source.overrideReasons.join(', '),
									})
								}}
							</p>
						</td>
						<td class="py-3 px-3 text-right tabular-nums text-text-primary">
							{{ formatNumber(source.messageCount, locale) }}
						</td>
						<td
							class="py-3 px-3 text-right font-medium tabular-nums"
							:class="healthTextClass[passRateTone(sourcePassRate(source))]"
						>
							{{ formatPassRate(sourcePassRate(source)) }}
						</td>
						<td class="py-3 pl-3 text-right tabular-nums text-text-secondary">
							{{ formatNumber(source.failingCount, locale) }}
						</td>
					</tr>
				</tbody>
			</table>
			<p v-if="totalCount > sources.length" class="mt-2 text-xs text-text-tertiary">
				{{
					t('components.delivery.dmarcSources.more', {
						shown: sources.length,
						total: totalCount,
					})
				}}
			</p>
		</div>
	</div>
</template>
