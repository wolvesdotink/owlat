<script setup lang="ts">
import type { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { formatNumber } from '~/utils/formatters';
import OperatorSendingStatusCard from '~/components/operator/SendingStatusCard.vue';
import { abuseStatusVariant, formatRate, riskLevelVariant } from '~/utils/operatorConsole';
import type { SendingStatusView } from '~/utils/suspensionLift';

type AbuseStatus = 'clean' | 'warned' | 'suspended' | 'banned';

defineProps<{
	currentAbuseStatus: string;
	abuseStatusReason: string | undefined;
	/** The soft auto-warn state: flagged, but sending still allowed. */
	isWarned: boolean;
	flaggedOrgs:
		| FunctionReturnType<typeof api.platformAdmin.queries.listFlaggedOrganizations>
		| undefined;
	allOrgs: FunctionReturnType<typeof api.platformAdmin.queries.listAllOrganizations> | undefined;
	/** Any console write is in flight; every action waits for it. */
	busy: boolean;
	sending?: SendingStatusView | null;
}>();

const emit = defineEmits<{ setStatus: [initial: AbuseStatus] }>();

const { t, te, locale } = useI18n();

/**
 * The words for a backend enum value. A value with no copy of its own falls
 * back to the raw value, which beats a blank badge.
 */
function enumLabel(group: 'abuseStatus' | 'riskLevel', value: string | undefined): string {
	if (!value) return '—';
	const key = `dashboard.admin.operator.index.${group}.${value}`;
	return te(key) ? t(key) : value;
}

/** Counts written the way the reader's locale writes them ("128,400", "128.400"). */
const formatCount = (value: number | undefined | null) => formatNumber(value, locale.value);
const formatPercent = (value: number | undefined) => formatRate(value, locale.value);
</script>

<template>
	<div class="space-y-6">
		<OperatorSendingStatusCard
			:current-abuse-status="currentAbuseStatus"
			:abuse-status-reason="abuseStatusReason"
			:is-warned="isWarned"
			:busy="busy"
			:sending="sending"
			@set-status="(initial) => emit('setStatus', initial)"
		/>

		<!-- Flagged organizations -->
		<div class="card">
			<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-4">
				{{ t('dashboard.admin.operator.index.flagged.title') }}
			</h3>
			<div v-if="!flaggedOrgs || flaggedOrgs.length === 0" class="text-caption text-text-tertiary">
				{{ t('dashboard.admin.operator.index.flagged.empty') }}
			</div>
			<ul v-else class="space-y-3">
				<li
					v-for="(o, i) in flaggedOrgs"
					:key="i"
					class="flex items-center justify-between gap-4 rounded-lg shadow-surface-1 p-4"
				>
					<div>
						<div class="flex items-center gap-2">
							<UiBadge :variant="abuseStatusVariant(o.abuseStatus)">{{
								enumLabel('abuseStatus', o.abuseStatus)
							}}</UiBadge>
							<UiBadge :variant="riskLevelVariant(o.riskLevel)">
								{{
									t('dashboard.admin.operator.index.flagged.risk', {
										level: enumLabel('riskLevel', o.riskLevel),
									})
								}}
							</UiBadge>
						</div>
						<p class="mt-1 text-xs text-text-tertiary">
							{{
								t('dashboard.admin.operator.index.flagged.rates', {
									bounce: formatPercent(o.bounceRate),
									complaint: formatPercent(o.complaintRate),
									sent: formatCount(o.totalSent),
								})
							}}
						</p>
					</div>
				</li>
			</ul>
		</div>

		<!-- All organizations -->
		<div class="card">
			<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-4">
				{{ t('dashboard.admin.operator.index.workspaces.title') }}
			</h3>
			<!-- Scroll container: sender, two badges and a count do not fit a
			     phone, and without this the card just clipped them. The negative
			     margin lets the scroll area bleed to the card's edges. -->
			<div class="-mx-6 px-6 overflow-x-auto">
				<table class="w-full min-w-max text-caption">
					<thead>
						<tr class="border-b border-border-subtle text-text-tertiary">
							<th class="text-left py-2 font-medium">
								{{ t('dashboard.admin.operator.index.workspaces.sender') }}
							</th>
							<th class="text-left py-2 font-medium">{{ t('common.status') }}</th>
							<th class="text-left py-2 font-medium">
								{{ t('dashboard.admin.operator.index.workspaces.risk') }}
							</th>
							<th class="text-right py-2 font-medium">
								{{ t('dashboard.admin.operator.index.workspaces.contacts') }}
							</th>
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="(o, i) in allOrgs ?? []"
							:key="i"
							class="border-b border-border-subtle last:border-b-0"
						>
							<td class="py-2 text-text-primary">
								{{ o.defaultFromName || o.defaultFromEmail || '—' }}
							</td>
							<td class="py-2">
								<UiBadge :variant="abuseStatusVariant(o.abuseStatus)">{{
									enumLabel('abuseStatus', o.abuseStatus)
								}}</UiBadge>
							</td>
							<td class="py-2">
								<UiBadge :variant="riskLevelVariant(o.riskLevel)">{{
									enumLabel('riskLevel', o.riskLevel)
								}}</UiBadge>
							</td>
							<td class="py-2 text-right text-text-secondary">
								{{ formatCount(o.contactCount) }}
							</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	</div>
</template>
