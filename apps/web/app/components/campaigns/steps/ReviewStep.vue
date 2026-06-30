<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isValidEmail } from '~/utils/validation';

type SendOption = 'now' | 'later';

interface EmailTemplate {
	readonly _id: Id<'emailTemplates'>;
	readonly name: string;
	readonly subject: string;
}

interface CampaignData {
	campaignId: Id<'campaigns'>;
	campaignName: string;
	fromName: string;
	fromEmail: string;
	replyTo: string;
	audienceDisplayText: string;
	audienceCount: number;
	campaignSubject: string;
	selectedTemplate: EmailTemplate | null;
	// A/B Test data
	abTestEnabled: boolean;
	abTestType: 'subject' | 'content';
	abVariantBSubject: string;
	abVariantBTemplateId: Id<'emailTemplates'> | null;
	abSplitPercentage: number;
	abWinnerCriteria: 'open_rate' | 'click_rate' | 'manual';
	abTestDuration: number;
	templates: readonly EmailTemplate[];
}

interface Props {
	data: CampaignData;
}

const props = defineProps<Props>();

const emit = defineEmits<{
	back: [];
	editStep: [step: string];
	complete: [];
}>();

const router = useRouter();
const { showToast } = useToast();

// Send options
const sendOption = ref<SendOption>('now');
const scheduledDate = ref('');
const scheduledTime = ref('');
const useRecipientTimezone = ref(false);

// Test email modal
const isTestEmailModalOpen = ref(false);

// Mutations
const { run: sendCampaignNow } = useBackendOperation(api.campaigns.campaigns.sendNow, {
	label: 'Send campaign now',
});
const { run: scheduleCampaign } = useBackendOperation(api.campaigns.scheduling.schedule, {
	label: 'Schedule campaign',
});

// Modal state — `error`/`setError` carry the send-blocked reason and local
// schedule validation; `isLoading` gates the button. Backend errors are
// surfaced by the operation module.
const { isLoading, error, setError, setLoading } = useModal();

const { data: domainVerificationStatus } = useOrganizationQuery(
	api.domains.domains.getEmailDomainVerificationStatus,
	() => {
		const email = props.data.fromEmail.trim();
		if (!email || !isValidEmail(email)) return undefined;
		return { email };
	}
);

const sendBlockedReason = computed(() => {
	const status = domainVerificationStatus.value;
	if (!status) return null;

	if (!status.exists) {
		return `Sending is disabled because "${status.domain}" is not registered. Add and verify it in Settings > Domains.`;
	}

	if (!status.verified) {
		return `Sending is disabled because "${status.domain}" is not verified. Complete DNS verification in Settings > Domains.`;
	}

	return null;
});

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
	return date.toLocaleString('en-US', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
	});
};

// Validation
const validate = (): boolean => {
	if (sendOption.value === 'later') {
		if (!scheduledDate.value) {
			setError('Please select a date for scheduling');
			return false;
		}

		if (!scheduledTime.value) {
			setError('Please select a time for scheduling');
			return false;
		}

		const scheduledDateTime = new Date(`${scheduledDate.value}T${scheduledTime.value}`);
		if (scheduledDateTime.getTime() <= Date.now()) {
			setError('Scheduled time must be in the future');
			return false;
		}
	}

	return true;
};

// Handle campaign send
const handleSendCampaign = async () => {
	if (sendBlockedReason.value) {
		setError(sendBlockedReason.value);
		return;
	}

	if (!validate()) return;

	setLoading(true);
	try {
		let toastMessage: string;

		if (sendOption.value === 'now') {
			if ((await sendCampaignNow({ campaignId: props.data.campaignId })) === undefined) return;
			toastMessage = 'Campaign is now sending!';
		} else {
			const scheduledDateTime = new Date(`${scheduledDate.value}T${scheduledTime.value}`);
			const scheduledHour = scheduledDateTime.getHours();
			const scheduledMinute = scheduledDateTime.getMinutes();

			const result = await scheduleCampaign({
				campaignId: props.data.campaignId,
				scheduledAt: scheduledDateTime.getTime(),
				useRecipientTimezone: useRecipientTimezone.value,
				scheduledHour: useRecipientTimezone.value ? scheduledHour : undefined,
				scheduledMinute: useRecipientTimezone.value ? scheduledMinute : undefined,
			});
			if (result === undefined) return;

			toastMessage = useRecipientTimezone.value
				? `Campaign scheduled for ${scheduledTime.value} in each recipient's timezone!`
				: 'Campaign scheduled successfully!';
		}

		showToast(toastMessage);

		setTimeout(() => {
			router.push('/dashboard/campaigns');
		}, 1500);

		emit('complete');
	} finally {
		setLoading(false);
	}
};

// Get variant B template name
const variantBTemplateName = computed(() => {
	if (!props.data.abVariantBTemplateId) return null;
	return props.data.templates.find((t) => t._id === props.data.abVariantBTemplateId)?.name ?? null;
});
</script>

<template>
	<div class="space-y-6">
		<!-- Campaign Summary Card -->
		<div class="card p-6">
			<div class="mb-6">
				<h2 class="text-xl font-semibold text-text-primary">Review & Send</h2>
				<p class="text-text-secondary mt-1">Review your campaign settings before sending.</p>
			</div>

			<!-- Error Alert -->
			<UiErrorAlert v-if="error" :message="error" class="mb-6" />

			<!-- Campaign Details Summary -->
			<div class="space-y-4">
				<!-- Campaign Name -->
				<div
					class="flex items-start justify-between p-4 bg-bg-surface border border-border-subtle rounded-lg"
				>
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:file-text" size="sm" rounded="lg" />
						<div>
							<p class="text-sm text-text-secondary">Campaign Name</p>
							<p class="font-medium text-text-primary mt-0.5">{{ data.campaignName }}</p>
						</div>
					</div>
					<button
						class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-elevated rounded-lg transition-colors"
						@click="emit('editStep', 'basics')"
					 aria-label="Edit">
						<Icon name="lucide:pencil" class="w-4 h-4" />
					</button>
				</div>

				<!-- From Info -->
				<div
					class="flex items-start justify-between p-4 bg-bg-surface border border-border-subtle rounded-lg"
				>
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:user" size="sm" rounded="lg" />
						<div>
							<p class="text-sm text-text-secondary">From</p>
							<p class="font-medium text-text-primary mt-0.5">{{ data.fromName }}</p>
							<p class="text-sm text-text-secondary">{{ data.fromEmail }}</p>
							<p v-if="data.replyTo" class="text-sm text-text-tertiary">
								Reply-to: {{ data.replyTo }}
							</p>
						</div>
					</div>
					<button
						class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-elevated rounded-lg transition-colors"
						@click="emit('editStep', 'basics')"
					 aria-label="Edit">
						<Icon name="lucide:pencil" class="w-4 h-4" />
					</button>
				</div>

				<!-- Audience -->
				<div
					class="flex items-start justify-between p-4 bg-bg-surface border border-border-subtle rounded-lg"
				>
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:users" size="sm" variant="success" rounded="lg" />
						<div>
							<p class="text-sm text-text-secondary">Audience</p>
							<p class="font-medium text-text-primary mt-0.5">{{ data.audienceDisplayText }}</p>
							<p class="text-sm text-text-secondary mt-1">
								<span class="font-medium text-brand">{{ data.audienceCount ?? 0 }}</span>
								estimated recipients
							</p>
						</div>
					</div>
					<button
						class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-elevated rounded-lg transition-colors"
						@click="emit('editStep', 'audience')"
					 aria-label="Edit">
						<Icon name="lucide:pencil" class="w-4 h-4" />
					</button>
				</div>

				<!-- Email Content -->
				<div
					class="flex items-start justify-between p-4 bg-bg-surface border border-border-subtle rounded-lg"
				>
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:mail" size="sm" variant="warning" rounded="lg" />
						<div class="flex-1 min-w-0">
							<p class="text-sm text-text-secondary">Email Content</p>
							<p class="font-medium text-text-primary mt-0.5">{{ data.campaignSubject }}</p>
							<div v-if="data.selectedTemplate" class="mt-2 flex items-center gap-2">
								<span class="text-sm text-text-secondary">Template:</span>
								<span class="text-sm text-text-primary">{{ data.selectedTemplate.name }}</span>
							</div>
							<p class="text-xs text-text-tertiary mt-2">
								You can edit this email after the campaign is created.
							</p>
						</div>
					</div>
					<button
						class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-elevated rounded-lg transition-colors"
						@click="emit('editStep', 'content')"
					 aria-label="Edit">
						<Icon name="lucide:pencil" class="w-4 h-4" />
					</button>
				</div>

				<!-- A/B Test Summary -->
				<div
					v-if="data.abTestEnabled"
					class="flex items-start justify-between p-4 bg-bg-surface border border-brand/30 rounded-lg"
				>
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:split" size="sm" rounded="lg" />
						<div class="flex-1 min-w-0">
							<p class="text-sm text-text-secondary">A/B Testing</p>
							<p class="font-medium text-text-primary mt-0.5">
								Testing {{ data.abTestType === 'subject' ? 'Subject Lines' : 'Email Templates' }}
							</p>
							<div class="mt-2 space-y-1">
								<div class="flex items-center gap-2 text-sm">
									<div
										class="w-5 h-5 rounded-full bg-brand/20 text-brand flex items-center justify-center text-xs font-bold"
									>
										A
									</div>
									<span class="text-text-secondary">{{
										data.abTestType === 'subject'
											? data.campaignSubject
											: data.selectedTemplate?.name
									}}</span>
								</div>
								<div class="flex items-center gap-2 text-sm">
									<div
										class="w-5 h-5 rounded-full bg-brand/20 text-brand flex items-center justify-center text-xs font-bold"
									>
										B
									</div>
									<span class="text-text-secondary">{{
										data.abTestType === 'subject' ? data.abVariantBSubject : variantBTemplateName
									}}</span>
								</div>
								<p class="text-sm text-text-tertiary mt-2">
									{{ data.abSplitPercentage }}% each for test, winner sent to
									remaining {{ Math.max(0, 100 - 2 * data.abSplitPercentage) }}%
								</p>
								<p class="text-sm text-text-tertiary">
									Winner by:
									{{
										data.abWinnerCriteria === 'open_rate'
											? 'Best Open Rate'
											: data.abWinnerCriteria === 'click_rate'
												? 'Best Click Rate'
												: 'Manual Selection'
									}}
									<template v-if="data.abWinnerCriteria !== 'manual'">
										(after {{ data.abTestDuration }}h)</template
									>
								</p>
							</div>
						</div>
					</div>
					<button
						class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-elevated rounded-lg transition-colors"
						@click="emit('editStep', 'abtest')"
					 aria-label="Edit">
						<Icon name="lucide:pencil" class="w-4 h-4" />
					</button>
				</div>
			</div>
		</div>

		<!-- Send Options Card -->
		<div class="card p-6">
			<h3 class="text-lg font-semibold text-text-primary mb-4">When to Send</h3>

			<div
				v-if="sendBlockedReason"
				class="mb-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
			>
				<Icon name="lucide:alert-circle" class="mt-0.5 h-4 w-4 shrink-0" />
				<p>{{ sendBlockedReason }}</p>
			</div>

			<div class="space-y-4">
				<!-- Send Now Option -->
				<label
					:class="[
						'flex items-start gap-4 p-4 border rounded-lg cursor-pointer transition-colors',
						sendOption === 'now'
							? 'border-brand bg-brand/5'
							: 'border-border-subtle hover:border-border-default',
					]"
				>
					<input
						v-model="sendOption"
						type="radio"
						name="sendOption"
						value="now"
						class="mt-1 w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface"
					/>
					<div class="flex-1">
						<div class="flex items-center gap-2">
							<Icon name="lucide:send" class="w-5 h-5 text-brand" />
							<span class="font-medium text-text-primary">Send Now</span>
						</div>
						<p class="text-sm text-text-secondary mt-1">
							Your campaign will start sending immediately to all recipients.
						</p>
					</div>
				</label>

				<!-- Schedule for Later Option -->
				<label
					:class="[
						'flex items-start gap-4 p-4 border rounded-lg cursor-pointer transition-colors',
						sendOption === 'later'
							? 'border-brand bg-brand/5'
							: 'border-border-subtle hover:border-border-default',
					]"
				>
					<input
						v-model="sendOption"
						type="radio"
						name="sendOption"
						value="later"
						class="mt-1 w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface"
					/>
					<div class="flex-1">
						<div class="flex items-center gap-2">
							<Icon name="lucide:clock" class="w-5 h-5 text-brand" />
							<span class="font-medium text-text-primary">Schedule for Later</span>
						</div>
						<p class="text-sm text-text-secondary mt-1">
							Choose a specific date and time to send your campaign.
						</p>

						<!-- Date/Time Picker -->
						<div v-if="sendOption === 'later'" class="mt-4 space-y-4" @click.stop>
							<div class="grid grid-cols-2 gap-4">
								<div>
									<label for="scheduleDate" class="label flex items-center gap-2">
										<Icon name="lucide:calendar" class="w-4 h-4 text-text-tertiary" />
										Date
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
										<Icon name="lucide:clock" class="w-4 h-4 text-text-tertiary" />
										Time
									</label>
									<input
										id="scheduleTime"
										v-model="scheduledTime"
										type="time"
										class="input mt-1.5"
									/>
								</div>
							</div>

							<!-- Timezone Scheduling Option -->
							<div class="mt-4">
								<label
									class="flex items-start gap-3 p-3 bg-bg-elevated border border-border-subtle rounded-lg cursor-pointer hover:border-border-default transition-colors"
								>
									<input
										v-model="useRecipientTimezone"
										type="checkbox"
										class="mt-0.5 w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface rounded"
									/>
									<div class="flex-1">
										<div class="flex items-center gap-2">
											<Icon name="lucide:globe" class="w-4 h-4 text-brand" />
											<span class="font-medium text-text-primary text-sm"
												>Send at recipient's local time</span
											>
										</div>
										<p class="text-xs text-text-secondary mt-1">
											Emails will be sent at {{ scheduledTime || 'the scheduled time' }} in each
											contact's timezone. Contacts without a timezone will receive the email at your
											selected time.
										</p>
									</div>
								</label>
							</div>

							<!-- Scheduled Time Preview -->
							<div
								v-if="scheduledDate && scheduledTime"
								class="p-3 bg-bg-elevated border border-border-subtle rounded-lg"
							>
								<template v-if="useRecipientTimezone">
									<p class="text-sm text-text-secondary">Your campaign will be sent at:</p>
									<p class="font-medium text-text-primary mt-1">
										{{ scheduledTime }} in each recipient's timezone
									</p>
									<p class="text-xs text-text-tertiary mt-2">
										For example: {{ scheduledTime }} ET, {{ scheduledTime }} PT,
										{{ scheduledTime }} GMT, etc.
									</p>
								</template>
								<template v-else>
									<p class="text-sm text-text-secondary">Your campaign will be sent:</p>
									<p class="font-medium text-text-primary mt-1">
										{{ formatScheduleDate(scheduledDate, scheduledTime) }}
									</p>
								</template>
							</div>
						</div>
					</div>
				</label>
			</div>
		</div>

		<!-- Test Email Section -->
		<div class="card p-6">
			<div class="flex items-center justify-between">
				<div>
					<h3 class="text-lg font-semibold text-text-primary">Send Test Email</h3>
					<p class="text-sm text-text-secondary mt-1">
						Preview how your email will look by sending a test to yourself.
					</p>
				</div>
				<UiButton variant="secondary" @click="isTestEmailModalOpen = true">
					<template #iconLeft><Icon name="lucide:send-horizonal" class="w-4 h-4" /></template>
					Send Test
				</UiButton>
			</div>
		</div>

		<!-- Actions -->
		<div class="flex items-center justify-between pt-2">
			<UiButton variant="secondary" @click="emit('back')">
				<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4" /></template>
				Back
			</UiButton>
			<UiButton
				:loading="isLoading"
				:disabled="
					isLoading || Boolean(sendBlockedReason) || (sendOption === 'later' && (!scheduledDate || !scheduledTime))
				"
				@click="handleSendCampaign"
			>
				<template v-if="!isLoading" #iconLeft><Icon name="lucide:send" class="w-4 h-4" /></template>
				{{
					isLoading
						? sendOption === 'now'
							? 'Sending...'
							: 'Scheduling...'
						: sendOption === 'now'
							? 'Send Campaign'
							: 'Schedule Campaign'
				}}
			</UiButton>
		</div>

		<!-- Test Email Modal -->
		<CampaignsTestEmailModal
			v-model:open="isTestEmailModalOpen"
			:campaign-id="data.campaignId"
			:subject="data.campaignSubject"
			:from-name="data.fromName"
			:from-email="data.fromEmail"
		/>
	</div>
</template>
