<script setup lang="ts">
import type { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { formatNumber } from '~/utils/formatters';
import {
	abuseStatusVariant,
	formatRate,
	isBlockingAbuseStatus,
	riskLevelVariant,
} from '~/utils/operatorConsole';

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
}>();

const emit = defineEmits<{ setStatus: [initial: AbuseStatus] }>();

const { t, locale } = useI18n();

/** Counts written the way the reader's locale writes them ("128,400", "128.400"). */
const formatCount = (value: number | undefined | null) => formatNumber(value, locale.value);
const formatPercent = (value: number | undefined) => formatRate(value, locale.value);
</script>

<template>
	<div class="space-y-6">
		<!-- Sending status control -->
		<div class="card">
			<div class="flex items-start justify-between gap-4 flex-wrap">
				<div>
					<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-2">
						{{ t('dashboard.admin.operator.index.sending.title') }}
					</h3>
					<div class="flex items-center gap-2">
						<UiBadge :variant="abuseStatusVariant(currentAbuseStatus)" size="md">{{
							currentAbuseStatus
						}}</UiBadge>
						<span v-if="isBlockingAbuseStatus(currentAbuseStatus)" class="text-caption text-error">
							{{ t('dashboard.admin.operator.index.sending.blocked') }}
						</span>
						<span v-else-if="isWarned" class="text-caption text-warning">
							{{ t('dashboard.admin.operator.index.sending.warned') }}
						</span>
					</div>
					<p v-if="abuseStatusReason" class="mt-2 text-caption text-text-secondary">
						{{
							t('dashboard.admin.operator.index.sending.reason', {
								reason: abuseStatusReason,
							})
						}}
					</p>
				</div>
				<div class="flex gap-2">
					<UiButton
						v-if="isBlockingAbuseStatus(currentAbuseStatus)"
						variant="primary"
						size="sm"
						:disabled="busy"
						@click="emit('setStatus', 'clean')"
					>
						{{ t('dashboard.admin.operator.index.sending.unsuspend') }}
					</UiButton>
					<UiButton
						v-else
						variant="danger-outline"
						size="sm"
						:disabled="busy"
						@click="emit('setStatus', 'suspended')"
					>
						{{ t('dashboard.admin.operator.index.sending.suspend') }}
					</UiButton>
				</div>
			</div>
		</div>

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
							<UiBadge :variant="abuseStatusVariant(o.abuseStatus)">{{ o.abuseStatus }}</UiBadge>
							<UiBadge :variant="riskLevelVariant(o.riskLevel)">
								{{ t('dashboard.admin.operator.index.flagged.risk', { level: o.riskLevel }) }}
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
								<UiBadge :variant="abuseStatusVariant(o.abuseStatus)">{{ o.abuseStatus }}</UiBadge>
							</td>
							<td class="py-2">
								<UiBadge :variant="riskLevelVariant(o.riskLevel)">{{ o.riskLevel }}</UiBadge>
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
