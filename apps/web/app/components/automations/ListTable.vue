<script lang="ts">
import type { Doc } from '@owlat/api/dataModel';

/** The fields of an `automations.list` row the list renders. */
export type AutomationListItem = Pick<
	Doc<'automations'>,
	'_id' | 'name' | 'description' | 'status' | 'triggerType' | 'statsActive' | 'createdAt'
>;
</script>

<script setup lang="ts">
/**
 * The rows of the automations list, as a table (`layout="table"`) or as the
 * card list below `md` (`layout="cards"`). `ListPageShell` decides which of the
 * two is mounted; this renders the one it is given. The row actions come in
 * through `#actions`, so both layouts carry the same controls.
 *
 * Each automation's name is a link — the keyboard route to it. A draft opens
 * the builder and anything else its detail page. A draft's detail page is
 * withheld everywhere in this list (it has never run, so there are no
 * analytics), so for a caller without `automations:manage` a draft's name
 * leads nowhere and is plain text rather than a link.
 */
import { formatDate, formatNumber } from '~/utils/formatters';

const props = defineProps<{
	items: AutomationListItem[];
	layout: 'table' | 'cards';
	canManage: boolean;
}>();

defineSlots<{
	actions?: (props: { automation: AutomationListItem; touch: boolean }) => unknown;
}>();

const { t } = useI18n();
const { getStatusBadge, getTriggerDisplay } = useAutomationBadges();

const nameTo = (automation: AutomationListItem): string | null => {
	if (automation.status !== 'draft') return `/dashboard/automations/${automation._id}`;
	return props.canManage ? `/dashboard/automations/${automation._id}/edit` : null;
};

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
const headerCell = 'text-left px-6 py-4 text-sm font-medium text-text-secondary whitespace-nowrap';
const statusPill =
	'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap';
</script>

<template>
	<ul v-if="layout === 'cards'" class="divide-y divide-border-subtle">
		<li v-for="automation in items" :key="automation._id" class="flex items-center gap-1 px-4 py-2">
			<div class="flex-1 min-w-0 py-1">
				<NuxtLink
					v-if="nameTo(automation)"
					:to="nameTo(automation)!"
					:class="['block text-text-primary font-medium truncate rounded', focusRing]"
				>
					{{ automation.name }}
				</NuxtLink>
				<span v-else class="block text-text-primary font-medium truncate">
					{{ automation.name }}
				</span>
				<span class="flex items-center gap-2 mt-1 min-w-0">
					<span :class="[statusPill, getStatusBadge(automation.status).color]">
						<Icon :name="getStatusBadge(automation.status).icon" class="w-3 h-3" />
						{{ t(getStatusBadge(automation.status).label) }}
					</span>
					<span class="text-sm text-text-secondary truncate">
						{{ t(getTriggerDisplay(automation.triggerType).label) }}
					</span>
				</span>
				<span class="flex items-center gap-1.5 text-xs text-text-tertiary mt-1">
					<Icon name="lucide:users" class="w-3.5 h-3.5" />
					<span class="tabular-nums">{{ formatNumber(automation.statsActive ?? 0) }}</span>
					<span aria-hidden="true">·</span>
					{{ formatDate(automation.createdAt) }}
				</span>
			</div>
			<slot name="actions" :automation="automation" :touch="true" />
		</li>
	</ul>

	<div v-else class="overflow-x-auto">
		<table class="w-full">
			<thead>
				<tr class="border-b border-border-subtle">
					<th :class="headerCell">{{ t('common.name') }}</th>
					<th :class="headerCell">{{ t('dashboard.automations.index.table.trigger') }}</th>
					<th :class="headerCell">{{ t('common.status') }}</th>
					<th :class="headerCell">
						{{ t('dashboard.automations.index.table.contactsInFlow') }}
					</th>
					<th :class="headerCell">{{ t('dashboard.automations.index.table.created') }}</th>
					<th class="text-right px-6 py-4 text-sm font-medium text-text-secondary">
						{{ t('common.actions') }}
					</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="automation in items"
					:key="automation._id"
					class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors"
				>
					<td class="px-6 py-4">
						<div class="min-w-0">
							<NuxtLink
								v-if="nameTo(automation)"
								:to="nameTo(automation)!"
								:class="[
									'text-text-primary font-medium hover:text-brand transition-colors rounded',
									focusRing,
								]"
							>
								{{ automation.name }}
							</NuxtLink>
							<span v-else class="text-text-primary font-medium">{{ automation.name }}</span>
							<p
								v-if="automation.description"
								class="text-sm text-text-tertiary truncate mt-0.5 max-w-xs"
							>
								{{ automation.description }}
							</p>
						</div>
					</td>
					<td class="px-6 py-4">
						<div class="flex items-center gap-1.5">
							<Icon
								:name="getTriggerDisplay(automation.triggerType).icon"
								class="w-4 h-4 text-text-tertiary"
							/>
							<span class="text-text-secondary text-sm">
								{{ t(getTriggerDisplay(automation.triggerType).label) }}
							</span>
						</div>
					</td>
					<td class="px-6 py-4">
						<span :class="[statusPill, getStatusBadge(automation.status).color]">
							<Icon :name="getStatusBadge(automation.status).icon" class="w-3 h-3" />
							{{ t(getStatusBadge(automation.status).label) }}
						</span>
					</td>
					<td class="px-6 py-4">
						<div class="flex items-center gap-1.5">
							<Icon name="lucide:users" class="w-4 h-4 text-text-tertiary" />
							<span class="text-text-secondary text-sm tabular-nums">
								{{ formatNumber(automation.statsActive ?? 0) }}
							</span>
						</div>
					</td>
					<td class="px-6 py-4">
						<span class="text-text-secondary text-sm whitespace-nowrap">
							{{ formatDate(automation.createdAt) }}
						</span>
					</td>
					<td class="px-6 py-4">
						<slot name="actions" :automation="automation" :touch="false" />
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
