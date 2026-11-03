<script setup lang="ts">
// The campaign report's "Opened" tab: one page of contacts who opened, with
// Previous / Next. The page owns the query and the offset.
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '@owlat/api/dataModel';
// TYPE-ONLY: the list needs the query's return shape, never the client.
import type { api } from '@owlat/api';
import { ChevronRightIcon, EyeIcon, UsersIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

defineProps<{
	campaignId: Id<'campaigns'>;
	contacts: FunctionReturnType<typeof api.delivery.sends.getOpenedContacts> | undefined;
	loading: boolean;
	offset: number;
	pageSize: number;
}>();

const emit = defineEmits<{ previous: []; next: [] }>();

const { t } = useI18n();
</script>

<template>
	<div>
		<div v-if="loading && !contacts" class="p-8 flex justify-center">
			<SpinnerIcon class="w-6 h-6 text-brand" />
		</div>

		<div v-else-if="!contacts || contacts.sends.length === 0" class="py-12 text-center">
			<EyeIcon class="w-10 h-10 text-text-tertiary mx-auto mb-3" :stroke-width="1.5" />
			<p class="text-text-secondary">
				{{ t('dashboard.campaigns.detail.report.openedEmpty') }}
			</p>
		</div>

		<div v-else>
			<div class="divide-y divide-border-subtle">
				<div
					v-for="send in contacts.sends"
					:key="send._id"
					class="px-4 sm:px-6 py-4 flex items-center justify-between hover:bg-bg-surface transition-colors duration-(--motion-fast)"
				>
					<div class="flex items-center gap-3 min-w-0">
						<UiIconBox :icon="UsersIcon" size="sm" rounded="full" />
						<div class="min-w-0">
							<div class="text-text-primary font-medium truncate">
								{{
									send.contact?.firstName ||
									send.contact?.email?.split('@')[0] ||
									t('common.unknown')
								}}
								{{ send.contact?.lastName || '' }}
							</div>
							<div class="text-sm text-text-tertiary truncate">
								{{ send.contact?.email || t('dashboard.campaigns.detail.report.noEmail') }}
							</div>
						</div>
					</div>
					<div class="flex items-center gap-4 shrink-0">
						<div class="text-right">
							<div class="text-sm text-text-secondary">
								{{ formatCompactRelativeTime(send.openedAt, { emptyLabel: '—' }) }}
							</div>
							<div v-if="send.openCount > 1" class="text-xs text-text-tertiary tabular-nums">
								{{
									t('dashboard.campaigns.detail.report.opensCount', {
										count: send.openCount,
									})
								}}
							</div>
						</div>
						<UiTooltip :text="t('dashboard.campaigns.detail.report.viewSendDetails')">
							<NuxtLink
								:to="`/dashboard/campaigns/${campaignId}/sends/${send._id}`"
								class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
								:aria-label="t('dashboard.campaigns.detail.report.viewSendDetails')"
							>
								<ChevronRightIcon class="w-4 h-4" />
							</NuxtLink>
						</UiTooltip>
					</div>
				</div>
			</div>

			<div
				v-if="contacts.total > pageSize"
				class="px-4 sm:px-6 py-4 border-t border-border-subtle flex items-center justify-between gap-3"
			>
				<UiButton
					variant="secondary"
					class="text-sm"
					:disabled="offset === 0"
					@click="emit('previous')"
				>
					{{ t('dashboard.campaigns.detail.report.pagination.previous') }}
				</UiButton>
				<span class="text-sm text-text-tertiary tabular-nums">
					{{
						t('dashboard.campaigns.detail.report.pagination.range', {
							from: offset + 1,
							to: Math.min(offset + pageSize, contacts.total),
							total: contacts.total,
						})
					}}
				</span>
				<UiButton
					variant="secondary"
					class="text-sm"
					:disabled="!contacts.hasMore"
					@click="emit('next')"
				>
					{{ t('dashboard.campaigns.detail.report.pagination.next') }}
				</UiButton>
			</div>
		</div>
	</div>
</template>
