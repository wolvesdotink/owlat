<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ABTestType, ABWinnerCriteria } from '~/composables/useCampaignABTest';
import {
	CircleCheckIcon,
	ClockIcon,
	EyeIcon,
	FileTextIcon,
	MailIcon,
	PencilIcon,
	ReloadIcon,
	SplitIcon,
	UsersIcon,
} from '@coolicons/vue';

const props = defineProps<{
	/** The current campaign subject line (for Variant A display) */
	campaignSubject: string;
	/** The selected template for Variant A (name display) */
	selectedTemplateName?: string;
	/** Available email templates for Variant B content selection */
	emailTemplates?: Array<{ _id: Id<'emailTemplates'>; name: string }> | null;
	/** The currently selected template ID (to exclude from Variant B options) */
	selectedTemplateId: Id<'emailTemplates'> | null;
	/** The template list failed to load, so the Variant B select would be empty. */
	templatesLoadFailed?: boolean;
	/**
	 * The parent already owns turning the test on and off (the wizard's
	 * "Add A/B test" / "Remove A/B test"), so a second switch here would be a
	 * second control for the same state.
	 */
	hideEnableToggle?: boolean;
}>();

defineEmits<{
	/** Try loading the template list again. */
	retryTemplates: [];
}>();

// A/B test state is passed via v-model bindings
const abTestEnabled = defineModel<boolean>('abTestEnabled', { required: true });
const abTestType = defineModel<ABTestType>('abTestType', { required: true });
const abVariantBSubject = defineModel<string>('abVariantBSubject', { required: true });
const abVariantBTemplateId = defineModel<Id<'emailTemplates'> | null>('abVariantBTemplateId', {
	required: true,
});
const abSplitPercentage = defineModel<number>('abSplitPercentage', { required: true });
const abWinnerCriteria = defineModel<ABWinnerCriteria>('abWinnerCriteria', { required: true });
const abTestDuration = defineModel<number>('abTestDuration', { required: true });

const { t } = useI18n();

const splitId = useId();
const remainingPercentage = computed(() => Math.max(0, 100 - 2 * abSplitPercentage.value));
const splitValueText = computed(() =>
	t('components.campaigns.abTestConfig.splitValueText', {
		percent: abSplitPercentage.value,
		remaining: remainingPercentage.value,
	})
);
const variantADisplay = computed(() =>
	abTestType.value === 'subject' ? props.campaignSubject : props.selectedTemplateName
);

const filteredTemplates = computed(() => {
	if (!props.emailTemplates) return [];
	return props.emailTemplates.filter((template) => template._id !== props.selectedTemplateId);
});

/** Hours the auto-winner test can run for, labelled through the catalog. */
const durationOptions = computed(() =>
	[1, 2, 4, 6, 12, 24].map((value) => ({
		value,
		label: t('components.campaigns.abTestConfig.durationHours', value),
	}))
);
</script>

<template>
	<div class="card p-6">
		<h2 class="text-lg font-semibold text-text-primary mb-6">
			{{ t('components.campaigns.abTestConfig.title') }}
		</h2>

		<div class="space-y-6">
			<!-- Enable A/B Test Toggle: the switch is the control, the card a larger pointer target for it -->
			<div
				v-if="!hideEnableToggle"
				:class="[
					'flex items-center justify-between gap-4 p-4 border rounded-lg cursor-pointer transition-colors',
					abTestEnabled
						? 'border-brand bg-brand/5'
						: 'border-border-subtle hover:border-border-default',
				]"
				@click="abTestEnabled = !abTestEnabled"
			>
				<div class="flex min-w-0 items-center gap-3">
					<div
						:class="[
							'p-2 rounded-lg shrink-0',
							abTestEnabled ? 'bg-brand/20 text-brand' : 'bg-bg-surface text-text-tertiary',
						]"
					>
						<SplitIcon class="w-5 h-5" />
					</div>
					<div>
						<p class="font-medium text-text-primary">
							{{ t('components.campaigns.abTestConfig.enableTitle') }}
						</p>
						<p class="text-sm text-text-secondary mt-0.5">
							{{ t('components.campaigns.abTestConfig.enableDescription') }}
						</p>
					</div>
				</div>
				<UiSwitch
					v-model="abTestEnabled"
					:label="t('components.campaigns.abTestConfig.enableSwitchLabel')"
					class="shrink-0"
					@click.stop
				/>
			</div>

			<!-- A/B Test Configuration (shown when enabled) -->
			<div
				v-if="abTestEnabled || hideEnableToggle"
				:class="['space-y-6', hideEnableToggle ? '' : 'pt-4 border-t border-border-subtle']"
			>
				<!-- Test Type Selection -->
				<fieldset>
					<legend class="label mb-3">
						{{ t('components.campaigns.abTestConfig.testTypeLabel') }}
					</legend>
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<label
							:class="[
								'flex items-start gap-4 p-4 border rounded-lg cursor-pointer transition-colors',
								abTestType === 'subject'
									? 'border-brand bg-brand/5'
									: 'border-border-subtle hover:border-border-default',
							]"
						>
							<input
								v-model="abTestType"
								type="radio"
								name="abTestType"
								value="subject"
								class="mt-1 w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface"
							/>
							<div>
								<p class="font-medium text-text-primary">
									{{ t('components.campaigns.abTestConfig.subjectOption') }}
								</p>
								<p class="text-sm text-text-secondary mt-0.5">
									{{ t('components.campaigns.abTestConfig.subjectOptionDescription') }}
								</p>
							</div>
						</label>
						<label
							:class="[
								'flex items-start gap-4 p-4 border rounded-lg cursor-pointer transition-colors',
								abTestType === 'content'
									? 'border-brand bg-brand/5'
									: 'border-border-subtle hover:border-border-default',
							]"
						>
							<input
								v-model="abTestType"
								type="radio"
								name="abTestType"
								value="content"
								class="mt-1 w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface"
							/>
							<div>
								<p class="font-medium text-text-primary">
									{{ t('components.campaigns.abTestConfig.contentOption') }}
								</p>
								<p class="text-sm text-text-secondary mt-0.5">
									{{ t('components.campaigns.abTestConfig.contentOptionDescription') }}
								</p>
							</div>
						</label>
					</div>
				</fieldset>

				<!-- Variant A (Current) -->
				<div class="p-4 bg-bg-surface shadow-surface-1 rounded-lg">
					<div class="flex items-center gap-2 mb-2">
						<div
							class="w-6 h-6 rounded-full bg-brand/20 text-brand flex items-center justify-center text-xs font-bold"
						>
							A
						</div>
						<span class="font-medium text-text-primary">{{
							t('components.campaigns.abTestConfig.variantAHeading')
						}}</span>
					</div>
					<p v-if="variantADisplay" class="text-sm text-text-secondary ml-8">
						{{ variantADisplay }}
					</p>
					<p v-else class="text-sm text-text-tertiary ml-8">
						{{
							abTestType === 'subject'
								? t('components.campaigns.abTestConfig.variantASubjectLater')
								: t('components.campaigns.abTestConfig.variantATemplateLater')
						}}
					</p>
				</div>

				<!-- Variant B Configuration -->
				<div class="p-4 bg-bg-surface shadow-surface-1 rounded-lg">
					<div class="flex items-center gap-2 mb-3">
						<div
							class="w-6 h-6 rounded-full bg-brand/20 text-brand flex items-center justify-center text-xs font-bold"
						>
							B
						</div>
						<span class="font-medium text-text-primary">{{
							t('components.campaigns.abTestConfig.variantBHeading')
						}}</span>
					</div>

					<!-- Subject Line B (for subject tests) -->
					<div v-if="abTestType === 'subject'" class="ml-8">
						<label for="abVariantBSubject" class="label flex items-center gap-2">
							<MailIcon class="w-4 h-4 text-text-tertiary" />
							{{ t('components.campaigns.abTestConfig.subjectBLabel') }}
						</label>
						<input
							id="abVariantBSubject"
							v-model="abVariantBSubject"
							type="text"
							:placeholder="t('components.campaigns.abTestConfig.subjectBPlaceholder')"
							class="input mt-1.5"
						/>
					</div>

					<!-- Template B (for content tests) -->
					<div v-else class="ml-8">
						<label for="abVariantBTemplate" class="label flex items-center gap-2">
							<FileTextIcon class="w-4 h-4 text-text-tertiary" />
							{{ t('components.campaigns.abTestConfig.templateBLabel') }}
						</label>
						<select id="abVariantBTemplate" v-model="abVariantBTemplateId" class="input mt-1.5">
							<option :value="null" disabled>
								{{ t('components.campaigns.abTestConfig.templateBPlaceholder') }}
							</option>
							<option
								v-for="template in filteredTemplates"
								:key="template._id"
								:value="template._id"
							>
								{{ template.name }}
							</option>
						</select>
						<UiErrorAlert
							v-if="templatesLoadFailed"
							class="mt-1.5"
							:message="t('components.campaigns.abTestConfig.templatesLoadFailed')"
							:action-label="t('common.tryAgain')"
							:action-icon="ReloadIcon"
							data-testid="ab-templates-load-failed"
							@action="$emit('retryTemplates')"
						/>
					</div>
				</div>

				<!-- Split Percentage -->
				<div>
					<label :for="splitId" class="label flex items-center gap-2">
						<UsersIcon class="w-4 h-4 text-text-tertiary" />
						{{ t('components.campaigns.abTestConfig.splitLabel') }}
					</label>
					<div class="space-y-3">
						<div class="flex items-center gap-4">
							<input
								:id="splitId"
								v-model.number="abSplitPercentage"
								type="range"
								min="10"
								max="50"
								step="10"
								:aria-valuetext="splitValueText"
								class="flex-1 h-2 bg-bg-surface rounded-full appearance-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-brand [&::-moz-range-thumb]:cursor-pointer"
							/>
							<span
								class="text-lg font-semibold text-brand w-16 text-right tabular-nums"
								aria-hidden="true"
								>{{ abSplitPercentage }}%</span
							>
						</div>
						<I18nT
							keypath="components.campaigns.abTestConfig.splitExplanation"
							tag="p"
							class="text-sm text-text-secondary"
							scope="global"
						>
							<template #variantA>
								<span class="text-brand font-medium">{{ abSplitPercentage }}%</span>
							</template>
							<template #variantB>
								<span class="text-brand font-medium">{{ abSplitPercentage }}%</span>
							</template>
							<template #remaining>
								<span class="font-medium">{{ remainingPercentage }}%</span>
							</template>
						</I18nT>
					</div>
				</div>

				<!-- Winner Criteria -->
				<fieldset>
					<legend class="label flex items-center gap-2">
						<CircleCheckIcon class="w-4 h-4 text-text-tertiary" />
						{{ t('components.campaigns.abTestConfig.winnerLabel') }}
					</legend>
					<div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
						<label
							:class="[
								'flex flex-col items-center p-4 border rounded-lg cursor-pointer transition-colors text-center has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand',
								abWinnerCriteria === 'open_rate'
									? 'border-brand bg-brand/5'
									: 'border-border-subtle hover:border-border-default',
							]"
						>
							<input
								v-model="abWinnerCriteria"
								type="radio"
								name="abWinnerCriteria"
								value="open_rate"
								class="sr-only"
							/>
							<EyeIcon class="w-5 h-5 text-brand mb-2" />
							<span class="text-sm font-medium text-text-primary">{{
								t('components.campaigns.abTestConfig.winnerOpenRate')
							}}</span>
							<span class="text-xs text-text-tertiary mt-1">{{
								t('components.campaigns.abTestConfig.winnerOpenRateHint')
							}}</span>
						</label>
						<label
							:class="[
								'flex flex-col items-center p-4 border rounded-lg cursor-pointer transition-colors text-center has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand',
								abWinnerCriteria === 'click_rate'
									? 'border-brand bg-brand/5'
									: 'border-border-subtle hover:border-border-default',
							]"
						>
							<input
								v-model="abWinnerCriteria"
								type="radio"
								name="abWinnerCriteria"
								value="click_rate"
								class="sr-only"
							/>
							<MailIcon class="w-5 h-5 text-brand mb-2" />
							<span class="text-sm font-medium text-text-primary">{{
								t('components.campaigns.abTestConfig.winnerClickRate')
							}}</span>
							<span class="text-xs text-text-tertiary mt-1">{{
								t('components.campaigns.abTestConfig.winnerClickRateHint')
							}}</span>
						</label>
						<label
							:class="[
								'flex flex-col items-center p-4 border rounded-lg cursor-pointer transition-colors text-center has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand',
								abWinnerCriteria === 'manual'
									? 'border-brand bg-brand/5'
									: 'border-border-subtle hover:border-border-default',
							]"
						>
							<input
								v-model="abWinnerCriteria"
								type="radio"
								name="abWinnerCriteria"
								value="manual"
								class="sr-only"
							/>
							<PencilIcon class="w-5 h-5 text-brand mb-2" />
							<span class="text-sm font-medium text-text-primary">{{
								t('components.campaigns.abTestConfig.winnerManual')
							}}</span>
							<span class="text-xs text-text-tertiary mt-1">{{
								t('components.campaigns.abTestConfig.winnerManualHint')
							}}</span>
						</label>
					</div>
				</fieldset>

				<!-- Test Duration (for auto winner selection) -->
				<div v-if="abWinnerCriteria !== 'manual'">
					<label for="abTestDuration" class="label flex items-center gap-2">
						<ClockIcon class="w-4 h-4 text-text-tertiary" />
						{{ t('components.campaigns.abTestConfig.durationLabel') }}
					</label>
					<div class="flex items-center gap-4 mt-1.5">
						<select id="abTestDuration" v-model="abTestDuration" class="input">
							<option v-for="option in durationOptions" :key="option.value" :value="option.value">
								{{ option.label }}
							</option>
						</select>
					</div>
					<p class="mt-1.5 text-sm text-text-tertiary">
						{{
							t('components.campaigns.abTestConfig.durationHint', {
								remaining: remainingPercentage,
							})
						}}
					</p>
				</div>
			</div>
		</div>
	</div>
</template>
