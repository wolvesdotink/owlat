<script setup lang="ts">
// The Review step's "When to send" card: why the send is blocked (if it is),
// today's headroom, and Send now or Schedule for later with its date, time,
// delivery-time choice and preview.
import type { Id } from '@owlat/api/dataModel';
import { parseScheduledStart } from '~/lib/campaignSchedule';
import type { SendBlocker } from '~/lib/campaignRefusal';
import type { SendingReadiness } from '~/lib/sendReadiness';
import type { SendTiming } from '~/lib/sendTiming';
import { CalendarIcon, ClockIcon, PaperPlaneIcon } from '@coolicons/vue';

defineProps<{
	campaignId: Id<'campaigns'>;
	isAbTest: boolean;
	sendBlocker: SendBlocker | null;
	readiness: SendingReadiness | null | undefined;
	/** The size a decision may be taken on: `null` (unknown) for a lower bound. */
	audienceSize: number | null;
}>();

const sendOption = defineModel<'now' | 'later'>('sendOption', { required: true });
const scheduledDate = defineModel<string>('scheduledDate', { required: true });
const scheduledTime = defineModel<string>('scheduledTime', { required: true });
const timing = defineModel<SendTiming>('timing', { required: true });

const { t, locale } = useI18n();

/** The chosen start for the send-time preview, or null while unset or past. */
const scheduledStartAt = computed(() =>
	parseScheduledStart(scheduledDate.value, scheduledTime.value, Date.now())
);

// Get min date for scheduling
const getMinScheduleDateTime = () => {
	const now = new Date();
	now.setMinutes(now.getMinutes() + 5);
	return now.toISOString().slice(0, 16);
};

// Format date for display
const formatScheduleDate = (dateStr: string, timeStr: string): string => {
	if (!dateStr || !timeStr) return '';
	const date = new Date(`${dateStr}T${timeStr}`);
	return date.toLocaleString(locale.value, {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
};
</script>

<template>
	<div class="card p-6">
		<h3 class="text-lg font-semibold text-text-primary mb-4">
			{{ t('components.campaigns.steps.reviewStep.whenToSend') }}
		</h3>

		<!-- Always in the DOM, so a blocker that appears or clears while the
		     sender is edited is announced. -->
		<div role="status">
			<CampaignsSendBlockedNote v-if="sendBlocker" :blocker="sendBlocker" class="mb-4" />
		</div>

		<!-- What can actually go out today, before either option is chosen. -->
		<CampaignsSendReadinessNote :readiness="readiness" :audience-size="audienceSize" class="mb-4" />

		<fieldset class="space-y-4">
			<legend class="sr-only">{{ t('components.campaigns.steps.reviewStep.whenToSend') }}</legend>
			<!-- Send Now Option -->
			<label
				:class="[
					'flex items-start gap-4 p-4 border rounded-lg cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand',
					sendOption === 'now'
						? 'border-text-primary bg-bg-surface'
						: 'border-border-subtle hover:border-border-default',
				]"
			>
				<input
					v-model="sendOption"
					type="radio"
					name="sendOption"
					value="now"
					class="mt-1 w-4 h-4 text-text-primary focus:ring-brand border-border-subtle bg-bg-surface"
				/>
				<div class="flex-1">
					<div class="flex items-center gap-2">
						<PaperPlaneIcon class="w-5 h-5 text-text-tertiary" />
						<span class="font-medium text-text-primary">{{
							t('components.campaigns.steps.reviewStep.sendNow')
						}}</span>
					</div>
					<p class="text-sm text-text-secondary mt-1">
						{{ t('components.campaigns.steps.reviewStep.sendNowDescription') }}
					</p>
				</div>
			</label>

			<!-- Schedule for Later Option. The label wraps only the radio and its
			     text; the date, time and timing controls sit beside it in the same
			     card, since a label may not hold other labels or controls. -->
			<div
				:class="[
					'p-4 border rounded-lg transition-colors has-[input[name=sendOption]:focus-visible]:ring-2 has-[input[name=sendOption]:focus-visible]:ring-brand',
					sendOption === 'later'
						? 'border-text-primary bg-bg-surface'
						: 'border-border-subtle hover:border-border-default',
				]"
			>
				<label class="flex items-start gap-4 cursor-pointer">
					<input
						v-model="sendOption"
						type="radio"
						name="sendOption"
						value="later"
						class="mt-1 w-4 h-4 text-text-primary focus:ring-brand border-border-subtle bg-bg-surface"
					/>
					<span class="flex-1">
						<span class="flex items-center gap-2">
							<ClockIcon class="w-5 h-5 text-text-tertiary" />
							<span class="font-medium text-text-primary">{{
								t('components.campaigns.steps.reviewStep.scheduleLater')
							}}</span>
						</span>
						<span class="block text-sm text-text-secondary mt-1">
							{{ t('components.campaigns.steps.reviewStep.scheduleLaterDescription') }}
						</span>
					</span>
				</label>

				<div class="pl-8">
					<!-- Date/Time Picker -->
					<div v-if="sendOption === 'later'" class="mt-4 space-y-4">
						<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
							<div>
								<label for="scheduleDate" class="label flex items-center gap-2">
									<CalendarIcon class="w-4 h-4 text-text-tertiary" />
									{{ t('components.campaigns.steps.reviewStep.dateLabel') }}
								</label>
								<input
									id="scheduleDate"
									v-model="scheduledDate"
									type="date"
									:min="getMinScheduleDateTime().slice(0, 10)"
									class="input mt-1.5"
								/>
							</div>
							<div>
								<label for="scheduleTime" class="label flex items-center gap-2">
									<ClockIcon class="w-4 h-4 text-text-tertiary" />
									{{ t('components.campaigns.steps.reviewStep.timeLabel') }}
								</label>
								<input id="scheduleTime" v-model="scheduledTime" type="time" class="input mt-1.5" />
							</div>
						</div>

						<CampaignsSendTimingOptions
							v-model="timing"
							:time="scheduledTime"
							:campaign-id="campaignId"
							:start-at="scheduledStartAt"
							:is-ab-test="isAbTest"
						/>

						<!-- Scheduled Time Preview -->
						<div
							v-if="scheduledDate && scheduledTime"
							class="p-3 bg-bg-elevated shadow-surface-1 rounded-lg"
						>
							<template v-if="timing.mode === 'optimized'">
								<p class="text-sm text-text-secondary">
									{{ t('components.campaigns.steps.reviewStep.previewHeadingOptimized') }}
								</p>
								<p class="font-medium text-text-primary mt-1">
									{{ formatScheduleDate(scheduledDate, scheduledTime) }}
								</p>
								<p class="text-xs text-text-tertiary mt-2">
									{{
										t('components.campaigns.steps.reviewStep.previewOptimized', {
											hours: timing.windowHours,
										})
									}}
								</p>
							</template>
							<template v-else-if="timing.mode === 'local'">
								<p class="text-sm text-text-secondary">
									{{ t('components.campaigns.steps.reviewStep.previewHeadingAt') }}
								</p>
								<p class="font-medium text-text-primary mt-1">
									{{
										t('components.campaigns.steps.reviewStep.previewPerTimezone', {
											time: scheduledTime,
										})
									}}
								</p>
								<p class="text-xs text-text-tertiary mt-2">
									{{
										t('components.campaigns.steps.reviewStep.previewExample', {
											time: scheduledTime,
										})
									}}
								</p>
							</template>
							<template v-else>
								<p class="text-sm text-text-secondary">
									{{ t('components.campaigns.steps.reviewStep.previewHeading') }}
								</p>
								<p class="font-medium text-text-primary mt-1">
									{{ formatScheduleDate(scheduledDate, scheduledTime) }}
								</p>
							</template>
						</div>
					</div>
				</div>
			</div>
		</fieldset>
	</div>
</template>
