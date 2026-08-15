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
const { t, locale } = useI18n();

// Send options
const sendOption = ref<SendOption>('now');
const scheduledDate = ref('');
const scheduledTime = ref('');
const useRecipientTimezone = ref(false);

// Test email modal
const isTestEmailModalOpen = ref(false);

/**
 * Pre-flight refused the send and handed back the multi-day schedule it would
 * take instead. Capacity is a SCHEDULE, not a failure (deliverability plan
 * D14), so the refusal is claimed here and rendered as a calm panel rather than
 * left to the generic red `invalid_state` toast.
 */
const { capacitySchedule, claimCapacityRefusal, dismissCapacitySchedule } = useCapacityRefusal();

// Mutations
const { run: sendCampaignNow } = useBackendOperation(api.campaigns.campaigns.sendNow, {
	label: () => t('components.campaigns.steps.reviewStep.sendNowOperation'),
	onError: claimCapacityRefusal,
});
const { run: scheduleCampaign } = useBackendOperation(api.campaigns.scheduling.schedule, {
	label: () => t('components.campaigns.steps.reviewStep.scheduleOperation'),
	onError: claimCapacityRefusal,
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

// TODAY'S HEADROOM, shown with the send options rather than after the send is
// attempted. Same paced projection the binding gate meters against
// (`campaigns/sendingReadiness.ts`), so this line and a capacity refusal can
// never quote different numbers.
const { data: sendingReadiness } = useOrganizationQuery(
	api.campaigns.sendingReadiness.getSendingReadiness,
	() => {
		const from = props.data.fromEmail.trim();
		return isValidEmail(from) ? { fromEmail: from } : {};
	}
);

const sendBlockedReason = computed(() => {
	const status = domainVerificationStatus.value;
	if (!status) return null;

	if (!status.exists) {
		return t('components.campaigns.steps.reviewStep.blocked.domainMissing', {
			domain: status.domain,
		});
	}

	if (!status.verified) {
		return t('components.campaigns.steps.reviewStep.blocked.domainUnverified', {
			domain: status.domain,
		});
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
	return date.toLocaleString(locale.value, {
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
			setError(t('components.campaigns.steps.reviewStep.errors.dateRequired'));
			return false;
		}

		if (!scheduledTime.value) {
			setError(t('components.campaigns.steps.reviewStep.errors.timeRequired'));
			return false;
		}

		const scheduledDateTime = new Date(`${scheduledDate.value}T${scheduledTime.value}`);
		if (scheduledDateTime.getTime() <= Date.now()) {
			setError(t('components.campaigns.steps.reviewStep.errors.timeInPast'));
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

	dismissCapacitySchedule();
	setLoading(true);
	try {
		let toastMessage: string;

		if (sendOption.value === 'now') {
			if ((await sendCampaignNow({ campaignId: props.data.campaignId })) === undefined) return;
			toastMessage = t('components.campaigns.steps.reviewStep.toast.sending');
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
				? t('components.campaigns.steps.reviewStep.toast.scheduledPerTimezone', {
						time: scheduledTime.value,
					})
				: t('components.campaigns.steps.reviewStep.toast.scheduled');
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

/** How the winner is picked, and — for an automatic pick — by when. */
const winnerByLine = computed(() => {
	const prefix = 'components.campaigns.steps.reviewStep';
	const criteria =
		props.data.abWinnerCriteria === 'open_rate'
			? t(`${prefix}.winnerCriteria.openRate`)
			: props.data.abWinnerCriteria === 'click_rate'
				? t(`${prefix}.winnerCriteria.clickRate`)
				: t(`${prefix}.winnerCriteria.manual`);
	return props.data.abWinnerCriteria === 'manual'
		? t(`${prefix}.winnerBy`, { criteria })
		: t(`${prefix}.winnerByAfterHours`, { criteria, hours: props.data.abTestDuration });
});

// Get variant B template name
const variantBTemplateName = computed(() => {
	if (!props.data.abVariantBTemplateId) return null;
	return (
		props.data.templates.find((template) => template._id === props.data.abVariantBTemplateId)
			?.name ?? null
	);
});
</script>

<template>
	<div class="space-y-6">
		<!-- Campaign Summary Card -->
		<div class="card p-6">
			<div class="mb-6">
				<h2 class="text-xl font-semibold text-text-primary">
					{{ t('components.campaigns.steps.reviewStep.title') }}
				</h2>
				<p class="text-text-secondary mt-1">
					{{ t('components.campaigns.steps.reviewStep.subtitle') }}
				</p>
			</div>

			<!-- Error Alert -->
			<UiErrorAlert v-if="error" :message="error" class="mb-6" />

			<CampaignsCapacitySchedulePanel
				v-if="capacitySchedule"
				:plan="capacitySchedule"
				class="mb-6"
			/>

			<!-- Campaign Details Summary -->
			<div class="space-y-4">
				<!-- Campaign Name -->
				<div class="flex items-start justify-between p-4 bg-bg-surface shadow-surface-1 rounded-lg">
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:file-text" size="sm" rounded="lg" />
						<div>
							<p class="text-sm text-text-secondary">
								{{ t('components.campaigns.steps.reviewStep.campaignName') }}
							</p>
							<p class="font-medium text-text-primary mt-0.5">{{ data.campaignName }}</p>
						</div>
					</div>
					<button
						class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						@click="emit('editStep', 'setup')"
						:aria-label="t('common.edit')"
					>
						<Icon name="lucide:pencil" class="w-4 h-4" />
					</button>
				</div>

				<!-- From Info -->
				<div class="flex items-start justify-between p-4 bg-bg-surface shadow-surface-1 rounded-lg">
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:user" size="sm" rounded="lg" />
						<div>
							<p class="text-sm text-text-secondary">
								{{ t('components.campaigns.steps.reviewStep.from') }}
							</p>
							<p class="font-medium text-text-primary mt-0.5">{{ data.fromName }}</p>
							<p class="text-sm text-text-secondary">{{ data.fromEmail }}</p>
							<p v-if="data.replyTo" class="text-sm text-text-tertiary">
								{{ t('components.campaigns.steps.reviewStep.replyTo', { email: data.replyTo }) }}
							</p>
						</div>
					</div>
					<button
						class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						@click="emit('editStep', 'setup')"
						:aria-label="t('common.edit')"
					>
						<Icon name="lucide:pencil" class="w-4 h-4" />
					</button>
				</div>

				<!-- Audience -->
				<div class="flex items-start justify-between p-4 bg-bg-surface shadow-surface-1 rounded-lg">
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:users" size="sm" variant="success" rounded="lg" />
						<div>
							<p class="text-sm text-text-secondary">
								{{ t('components.campaigns.steps.reviewStep.audience') }}
							</p>
							<p class="font-medium text-text-primary mt-0.5">{{ data.audienceDisplayText }}</p>
							<I18nT
								keypath="components.campaigns.steps.reviewStep.estimatedRecipients"
								tag="p"
								class="text-sm text-text-secondary mt-1"
								scope="global"
							>
								<template #count>
									<span class="font-medium text-brand">{{ data.audienceCount ?? 0 }}</span>
								</template>
							</I18nT>
						</div>
					</div>
					<button
						class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						@click="emit('editStep', 'setup')"
						:aria-label="t('common.edit')"
					>
						<Icon name="lucide:pencil" class="w-4 h-4" />
					</button>
				</div>

				<!-- Email Content -->
				<div class="flex items-start justify-between p-4 bg-bg-surface shadow-surface-1 rounded-lg">
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:mail" size="sm" variant="warning" rounded="lg" />
						<div class="flex-1 min-w-0">
							<p class="text-sm text-text-secondary">
								{{ t('components.campaigns.steps.reviewStep.emailContent') }}
							</p>
							<p class="font-medium text-text-primary mt-0.5">{{ data.campaignSubject }}</p>
							<div v-if="data.selectedTemplate" class="mt-2 flex items-center gap-2">
								<span class="text-sm text-text-secondary">{{
									t('components.campaigns.steps.reviewStep.template')
								}}</span>
								<span class="text-sm text-text-primary">{{ data.selectedTemplate.name }}</span>
							</div>
							<p class="text-xs text-text-tertiary mt-2">
								{{ t('components.campaigns.steps.reviewStep.editLater') }}
							</p>
						</div>
					</div>
					<button
						class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						@click="emit('editStep', 'content')"
						:aria-label="t('common.edit')"
					>
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
							<p class="text-sm text-text-secondary">
								{{ t('components.campaigns.steps.reviewStep.abTesting') }}
							</p>
							<p class="font-medium text-text-primary mt-0.5">
								{{
									data.abTestType === 'subject'
										? t('components.campaigns.steps.reviewStep.testingSubjects')
										: t('components.campaigns.steps.reviewStep.testingTemplates')
								}}
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
									{{
										t('components.campaigns.steps.reviewStep.splitSummary', {
											split: data.abSplitPercentage,
											remaining: Math.max(0, 100 - 2 * data.abSplitPercentage),
										})
									}}
								</p>
								<p class="text-sm text-text-tertiary">{{ winnerByLine }}</p>
							</div>
						</div>
					</div>
					<button
						class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						@click="emit('editStep', 'setup')"
						:aria-label="t('common.edit')"
					>
						<Icon name="lucide:pencil" class="w-4 h-4" />
					</button>
				</div>
			</div>
		</div>

		<!-- Send Options Card -->
		<div class="card p-6">
			<h3 class="text-lg font-semibold text-text-primary mb-4">
				{{ t('components.campaigns.steps.reviewStep.whenToSend') }}
			</h3>

			<div
				v-if="sendBlockedReason"
				class="mb-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
			>
				<Icon name="lucide:alert-circle" class="mt-0.5 h-4 w-4 shrink-0" />
				<p>{{ sendBlockedReason }}</p>
			</div>

			<!-- What can actually go out today, before either option is chosen. -->
			<CampaignsSendReadinessNote
				:readiness="sendingReadiness"
				:audience-size="data.audienceCount"
				class="mb-4"
			/>

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
							<span class="font-medium text-text-primary">{{ t('components.campaigns.steps.reviewStep.sendNow') }}</span>
						</div>
						<p class="text-sm text-text-secondary mt-1">
							{{ t('components.campaigns.steps.reviewStep.sendNowDescription') }}
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
							<span class="font-medium text-text-primary">{{
								t('components.campaigns.steps.reviewStep.scheduleLater')
							}}</span>
						</div>
						<p class="text-sm text-text-secondary mt-1">
							{{ t('components.campaigns.steps.reviewStep.scheduleLaterDescription') }}
						</p>

						<!-- Date/Time Picker -->
						<div v-if="sendOption === 'later'" class="mt-4 space-y-4" @click.stop>
							<div class="grid grid-cols-2 gap-4">
								<div>
									<label for="scheduleDate" class="label flex items-center gap-2">
										<Icon name="lucide:calendar" class="w-4 h-4 text-text-tertiary" />
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
										<Icon name="lucide:clock" class="w-4 h-4 text-text-tertiary" />
										{{ t('components.campaigns.steps.reviewStep.timeLabel') }}
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
									class="flex items-start gap-3 p-3 bg-bg-elevated shadow-surface-1 rounded-lg cursor-pointer hover:bg-bg-surface-hover transition-colors"
								>
									<input
										v-model="useRecipientTimezone"
										type="checkbox"
										class="mt-0.5 w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface rounded"
									/>
									<div class="flex-1">
										<div class="flex items-center gap-2">
											<Icon name="lucide:globe" class="w-4 h-4 text-brand" />
											<span class="font-medium text-text-primary text-sm">{{
												t('components.campaigns.steps.reviewStep.recipientTimezone')
											}}</span>
										</div>
										<p class="text-xs text-text-secondary mt-1">
											{{
												t('components.campaigns.steps.reviewStep.recipientTimezoneHint', {
													time: scheduledTime || t('components.campaigns.steps.reviewStep.scheduledTimeFallback'),
												})
											}}
										</p>
									</div>
								</label>
							</div>

							<!-- Scheduled Time Preview -->
							<div
								v-if="scheduledDate && scheduledTime"
								class="p-3 bg-bg-elevated shadow-surface-1 rounded-lg"
							>
								<template v-if="useRecipientTimezone">
									<p class="text-sm text-text-secondary">{{ t('components.campaigns.steps.reviewStep.previewHeadingAt') }}</p>
									<p class="font-medium text-text-primary mt-1">
										{{ t('components.campaigns.steps.reviewStep.previewPerTimezone', { time: scheduledTime }) }}
									</p>
									<p class="text-xs text-text-tertiary mt-2">
										{{ t('components.campaigns.steps.reviewStep.previewExample', { time: scheduledTime }) }}
									</p>
								</template>
								<template v-else>
									<p class="text-sm text-text-secondary">{{ t('components.campaigns.steps.reviewStep.previewHeading') }}</p>
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
					<h3 class="text-lg font-semibold text-text-primary">
						{{ t('components.campaigns.steps.reviewStep.testEmailTitle') }}
					</h3>
					<p class="text-sm text-text-secondary mt-1">
						{{ t('components.campaigns.steps.reviewStep.testEmailDescription') }}
					</p>
				</div>
				<UiButton variant="secondary" @click="isTestEmailModalOpen = true">
					<template #iconLeft><Icon name="lucide:send-horizonal" class="w-4 h-4" /></template>
					{{ t('components.campaigns.steps.reviewStep.sendTest') }}
				</UiButton>
			</div>
		</div>

		<!-- Actions -->
		<div class="flex items-center justify-between pt-2">
			<UiButton variant="secondary" @click="emit('back')">
				<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4" /></template>
				{{ t('common.back') }}
			</UiButton>
			<UiButton
				:loading="isLoading"
				:disabled="
					isLoading ||
					Boolean(sendBlockedReason) ||
					(sendOption === 'later' && (!scheduledDate || !scheduledTime))
				"
				@click="handleSendCampaign"
			>
				<template v-if="!isLoading" #iconLeft><Icon name="lucide:send" class="w-4 h-4" /></template>
				{{
					isLoading
						? sendOption === 'now'
							? t('components.campaigns.steps.reviewStep.sending')
							: t('components.campaigns.steps.reviewStep.scheduling')
						: sendOption === 'now'
							? t('components.campaigns.steps.reviewStep.sendCampaign')
							: t('components.campaigns.steps.reviewStep.scheduleCampaign')
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
