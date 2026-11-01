<script setup lang="ts">
// The campaign editor's schedule card: date, time, how each recipient's
// delivery time is picked, and a preview of when the send starts.
import type { Id } from '@owlat/api/dataModel';
import type { SendTiming } from '~/lib/sendTiming';
import { CalendarIcon, ClockIcon } from '@coolicons/vue';

defineProps<{
	isScheduled: boolean;
	campaignId: Id<'campaigns'>;
	startAt: number | null;
	isAbTest: boolean;
	minDate: string;
	formatDate: (date: string, time: string) => string;
}>();

const scheduledDate = defineModel<string>('scheduledDate', { required: true });
const scheduledTime = defineModel<string>('scheduledTime', { required: true });
const sendTiming = defineModel<SendTiming>('sendTiming', { required: true });

const { t } = useI18n();
</script>

<template>
	<div class="card p-6">
		<h2 class="text-lg font-semibold text-text-primary mb-6">
			{{
				isScheduled
					? t('dashboard.campaigns.detail.edit.schedule.retitle')
					: t('dashboard.campaigns.detail.edit.schedule.title')
			}}
		</h2>

		<div class="grid grid-cols-2 gap-4">
			<div>
				<label for="scheduleDate" class="label flex items-center gap-2">
					<CalendarIcon class="w-4 h-4 text-text-tertiary" />
					{{ t('dashboard.campaigns.detail.edit.schedule.date') }}
				</label>
				<input
					id="scheduleDate"
					v-model="scheduledDate"
					type="date"
					:min="minDate"
					class="input mt-1.5"
				/>
			</div>
			<div>
				<label for="scheduleTime" class="label flex items-center gap-2">
					<ClockIcon class="w-4 h-4 text-text-tertiary" />
					{{ t('dashboard.campaigns.detail.edit.schedule.time') }}
				</label>
				<input id="scheduleTime" v-model="scheduledTime" type="time" class="input mt-1.5" />
			</div>
		</div>

		<!-- Delivery time (also honored on reschedule) -->
		<CampaignsSendTimingOptions
			v-model="sendTiming"
			class="mt-4"
			:time="scheduledTime"
			:campaign-id="campaignId"
			:start-at="startAt"
			:is-ab-test="isAbTest"
		/>

		<div
			v-if="scheduledDate && scheduledTime"
			class="mt-4 p-3 bg-bg-surface shadow-surface-1 rounded-lg"
		>
			<template v-if="sendTiming.mode === 'optimized'">
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.campaigns.detail.edit.schedule.willStartAt') }}
				</p>
				<p class="font-medium text-text-primary mt-1">
					{{ formatDate(scheduledDate, scheduledTime) }}
				</p>
				<p class="text-xs text-text-tertiary mt-2">
					{{
						t('dashboard.campaigns.detail.edit.schedule.optimizedWithin', {
							hours: sendTiming.windowHours,
						})
					}}
				</p>
			</template>
			<template v-else-if="sendTiming.mode === 'local'">
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.campaigns.detail.edit.schedule.willBeSentAt') }}
				</p>
				<p class="font-medium text-text-primary mt-1">
					{{
						t('dashboard.campaigns.detail.edit.schedule.inRecipientTimezone', {
							time: scheduledTime,
						})
					}}
				</p>
				<p class="text-xs text-text-tertiary mt-2">
					{{
						t('dashboard.campaigns.detail.edit.schedule.timezoneExamples', {
							time: scheduledTime,
						})
					}}
				</p>
			</template>
			<template v-else>
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.campaigns.detail.edit.schedule.willBeSent') }}
				</p>
				<p class="font-medium text-text-primary mt-1">
					{{ formatDate(scheduledDate, scheduledTime) }}
				</p>
			</template>
		</div>
	</div>
</template>
