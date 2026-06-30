<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

type ABTestType = 'subject' | 'content';
type ABWinnerCriteria = 'open_rate' | 'click_rate' | 'manual';

interface EmailTemplate {
	_id: Id<'emailTemplates'>;
	name: string;
	subject: string;
}

interface Props {
	campaignId: Id<'campaigns'>;
	campaignSubject: string;
	selectedTemplate: EmailTemplate | null;
	templates: EmailTemplate[];
	initialData?: {
		abTestEnabled: boolean;
		abTestType: ABTestType;
		abVariantBSubject: string;
		abVariantBTemplateId: Id<'emailTemplates'> | null;
		abSplitPercentage: number;
		abWinnerCriteria: ABWinnerCriteria;
		abTestDuration: number;
	};
}

const props = withDefaults(defineProps<Props>(), {
	initialData: () => ({
		abTestEnabled: false,
		abTestType: 'subject' as ABTestType,
		abVariantBSubject: '',
		abVariantBTemplateId: null,
		abSplitPercentage: 20,
		abWinnerCriteria: 'open_rate' as ABWinnerCriteria,
		abTestDuration: 4,
	}),
});

const emit = defineEmits<{
	submit: [];
	back: [];
}>();

// Form state
const abTestEnabled = ref(props.initialData.abTestEnabled);
const abTestType = ref<ABTestType>(props.initialData.abTestType);
const abVariantBSubject = ref(props.initialData.abVariantBSubject);
const abVariantBTemplateId = ref<Id<'emailTemplates'> | null>(
	props.initialData.abVariantBTemplateId
);
const abSplitPercentage = ref(props.initialData.abSplitPercentage);
const abWinnerCriteria = ref<ABWinnerCriteria>(props.initialData.abWinnerCriteria);
const abTestDuration = ref(props.initialData.abTestDuration);

// Watch for prop changes
watch(
	() => props.initialData,
	(newData) => {
		if (newData) {
			abTestEnabled.value = newData.abTestEnabled;
			abTestType.value = newData.abTestType;
			abVariantBSubject.value = newData.abVariantBSubject;
			abVariantBTemplateId.value = newData.abVariantBTemplateId;
			abSplitPercentage.value = newData.abSplitPercentage;
			abWinnerCriteria.value = newData.abWinnerCriteria;
			abTestDuration.value = newData.abTestDuration;
		}
	}
);

// Mutations
const { run: enableABTest } = useBackendOperation(api.campaigns.abTest.enableABTest, {
	label: 'Enable A/B test',
});
const { run: disableABTest } = useBackendOperation(api.campaigns.abTest.disableABTest, {
	label: 'Disable A/B test',
});

// Modal state — `error`/`setError` carry local form validation; `isLoading`
// gates the submit button. Backend errors are surfaced by the operation module.
const { isLoading, error, setError, setLoading } = useModal();

// Validation
const validate = (): boolean => {
	if (!abTestEnabled.value) {
		return true;
	}

	if (abTestType.value === 'subject' && !abVariantBSubject.value.trim()) {
		setError('Variant B subject line is required');
		return false;
	}

	if (abTestType.value === 'content' && !abVariantBTemplateId.value) {
		setError('Variant B email template is required');
		return false;
	}

	if (abSplitPercentage.value < 10 || abSplitPercentage.value > 50) {
		setError('Split percentage must be between 10% and 50%');
		return false;
	}

	return true;
};

const handleSubmit = async () => {
	if (!validate()) return;

	setLoading(true);
	try {
		if (abTestEnabled.value) {
			const result = await enableABTest({
				campaignId: props.campaignId,
				testType: abTestType.value,
				variantBSubject:
					abTestType.value === 'subject' ? abVariantBSubject.value.trim() : undefined,
				variantBTemplateId:
					abTestType.value === 'content' ? abVariantBTemplateId.value! : undefined,
				splitPercentage: abSplitPercentage.value,
				winnerCriteria: abWinnerCriteria.value,
				testDuration: abWinnerCriteria.value !== 'manual' ? abTestDuration.value : undefined,
			});
			if (result === undefined) return;
		} else {
			if ((await disableABTest({ campaignId: props.campaignId })) === undefined) return;
		}

		emit('submit');
	} finally {
		setLoading(false);
	}
};

// Expose form data for parent
defineExpose({
	abTestEnabled,
	abTestType,
	abVariantBSubject,
	abVariantBTemplateId,
	abSplitPercentage,
	abWinnerCriteria,
	abTestDuration,
});
</script>

<template>
	<div class="card p-6">
		<div class="mb-6">
			<h2 class="text-xl font-semibold text-text-primary">A/B Testing</h2>
			<p class="text-text-secondary mt-1">
				Test different versions of your email to see which performs better.
			</p>
		</div>

		<!-- Error Alert -->
		<UiErrorAlert v-if="error" :message="error" class="mb-6" />

		<form @submit.prevent="handleSubmit">
			<div class="space-y-6">
				<!-- Enable A/B Test Toggle -->
				<div
					:class="[
						'flex items-center justify-between p-4 border rounded-lg cursor-pointer transition-colors',
						abTestEnabled
							? 'border-brand bg-brand/5'
							: 'border-border-subtle hover:border-border-default',
					]"
					@click="abTestEnabled = !abTestEnabled"
				>
					<div class="flex items-center gap-3">
						<div
							:class="[
								'p-2 rounded-lg',
								abTestEnabled ? 'bg-brand/20 text-brand' : 'bg-bg-surface text-text-tertiary',
							]"
						>
							<Icon name="lucide:split" class="w-5 h-5" />
						</div>
						<div>
							<p class="font-medium text-text-primary">Enable A/B Testing</p>
							<p class="text-sm text-text-secondary mt-0.5">
								Split your audience to test different versions of your email
							</p>
						</div>
					</div>
					<!-- Decorative: the whole card is the click target -->
					<UiSwitch
						:model-value="abTestEnabled"
						label="Enable A/B testing"
						class="pointer-events-none"
						tabindex="-1"
					/>
				</div>

				<!-- A/B Test Configuration (shown when enabled) -->
				<div v-if="abTestEnabled" class="space-y-6 pt-4 border-t border-border-subtle">
					<!-- Test Type Selection -->
					<div>
						<label class="label mb-3">What do you want to test?</label>
						<div class="space-y-3">
							<!-- Subject Line Test -->
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
								<div class="flex-1">
									<div class="flex items-center gap-2">
										<Icon name="lucide:mail" class="w-5 h-5 text-brand" />
										<span class="font-medium text-text-primary">Subject Line</span>
									</div>
									<p class="text-sm text-text-secondary mt-1">
										Test different subject lines with the same email content.
									</p>
								</div>
							</label>

							<!-- Content Test -->
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
								<div class="flex-1">
									<div class="flex items-center gap-2">
										<Icon name="lucide:file-text" class="w-5 h-5 text-brand" />
										<span class="font-medium text-text-primary">Email Content</span>
									</div>
									<p class="text-sm text-text-secondary mt-1">
										Test completely different email templates.
									</p>
								</div>
							</label>
						</div>
					</div>

					<!-- Variant A Display -->
					<div class="p-4 bg-bg-surface border border-border-subtle rounded-lg">
						<div class="flex items-center gap-2 mb-3">
							<div
								class="w-6 h-6 rounded-full bg-brand/20 text-brand flex items-center justify-center text-sm font-bold"
							>
								A
							</div>
							<span class="font-medium text-text-primary">Variant A (Original)</span>
						</div>
						<div class="ml-8">
							<template v-if="abTestType === 'subject'">
								<p class="text-sm text-text-secondary">Subject:</p>
								<p class="text-text-primary">{{ campaignSubject }}</p>
							</template>
							<template v-else>
								<p class="text-sm text-text-secondary">Template:</p>
								<p class="text-text-primary">
									{{ selectedTemplate?.name || 'No template selected' }}
								</p>
							</template>
						</div>
					</div>

					<!-- Variant B Configuration -->
					<div>
						<div class="flex items-center gap-2 mb-3">
							<div
								class="w-6 h-6 rounded-full bg-brand/20 text-brand flex items-center justify-center text-sm font-bold"
							>
								B
							</div>
							<span class="font-medium text-text-primary">Variant B</span>
						</div>

						<!-- Subject Line B -->
						<div v-if="abTestType === 'subject'">
							<label for="abVariantBSubject" class="label flex items-center gap-2">
								<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary" />
								Alternative Subject Line <span class="text-error">*</span>
							</label>
							<input
								id="abVariantBSubject"
								v-model="abVariantBSubject"
								type="text"
								placeholder="Enter an alternative subject line to test..."
								class="input mt-1.5"
							/>
						</div>

						<!-- Template B -->
						<div v-else>
							<label class="label mb-2">Select Alternative Email Template</label>
							<div class="space-y-2 max-h-60 overflow-y-auto">
								<button
									v-for="template in templates"
									:key="template._id"
									type="button"
									:class="[
										'w-full flex items-center gap-3 p-3 border rounded-lg text-left transition-colors',
										abVariantBTemplateId === template._id
											? 'border-brand bg-brand/5'
											: 'border-border-subtle hover:border-border-default',
										template._id === selectedTemplate?._id ? 'opacity-50 cursor-not-allowed' : '',
									]"
									:disabled="template._id === selectedTemplate?._id"
									@click="abVariantBTemplateId = template._id"
								>
									<div
										:class="[
											'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
											abVariantBTemplateId === template._id
												? 'bg-brand/20 text-brand'
												: 'bg-bg-elevated text-text-tertiary',
										]"
									>
										<Icon name="lucide:mail" class="w-4 h-4" />
									</div>
									<div class="flex-1 min-w-0">
										<p class="font-medium text-text-primary truncate">
											{{ template.name }}
											<span
												v-if="template._id === selectedTemplate?._id"
												class="text-text-tertiary text-sm"
												>(Variant A)</span
											>
										</p>
										<p class="text-sm text-text-secondary truncate">
											{{ template.subject || 'No subject' }}
										</p>
									</div>
									<Icon
										v-if="abVariantBTemplateId === template._id"
										name="lucide:check"
										class="w-4 h-4 text-brand shrink-0"
									/>
								</button>
							</div>
						</div>
					</div>

					<!-- Split Percentage -->
					<div>
						<label class="label flex items-center gap-2 mb-3">
							<Icon name="lucide:users" class="w-4 h-4 text-text-tertiary" />
							Test Split Percentage
						</label>
						<div class="space-y-3">
							<div class="flex items-center gap-4">
								<input
									v-model.number="abSplitPercentage"
									type="range"
									min="10"
									max="50"
									step="10"
									class="flex-1 h-2 bg-bg-surface rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand [&::-webkit-slider-thumb]:cursor-pointer"
								/>
								<span class="text-lg font-semibold text-brand w-16 text-right"
									>{{ abSplitPercentage }}%</span
								>
							</div>
							<p class="text-sm text-text-secondary">
								<span class="text-brand font-medium">{{ abSplitPercentage }}%</span>
								of audience gets Variant A,
								<span class="text-brand font-medium">{{ abSplitPercentage }}%</span>
								gets Variant B. The remaining
								<span class="font-medium">{{ Math.max(0, 100 - 2 * abSplitPercentage) }}%</span>
								will receive the winning version.
							</p>
						</div>
					</div>

					<!-- Winner Criteria -->
					<div>
						<label class="label flex items-center gap-2 mb-3">
							<Icon name="lucide:trophy" class="w-4 h-4 text-text-tertiary" />
							How should the winner be selected?
						</label>
						<div class="space-y-3">
							<label
								:class="[
									'flex items-center gap-4 p-4 border rounded-lg cursor-pointer transition-colors',
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
									class="w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface"
								/>
								<div class="flex items-center gap-2 flex-1">
									<Icon name="lucide:mail-open" class="w-5 h-5 text-brand" />
									<span class="font-medium text-text-primary">Best Open Rate</span>
									<span class="text-sm text-text-tertiary">(Recommended)</span>
								</div>
							</label>

							<label
								:class="[
									'flex items-center gap-4 p-4 border rounded-lg cursor-pointer transition-colors',
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
									class="w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface"
								/>
								<div class="flex items-center gap-2">
									<Icon name="lucide:mouse-pointer" class="w-5 h-5 text-brand" />
									<span class="font-medium text-text-primary">Best Click Rate</span>
								</div>
							</label>

							<label
								:class="[
									'flex items-center gap-4 p-4 border rounded-lg cursor-pointer transition-colors',
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
									class="w-4 h-4 text-brand focus:ring-brand border-border-subtle bg-bg-surface"
								/>
								<div class="flex items-center gap-2">
									<Icon name="lucide:user" class="w-5 h-5 text-warning" />
									<span class="font-medium text-text-primary">I'll choose manually</span>
								</div>
							</label>
						</div>
					</div>

					<!-- Test Duration -->
					<div v-if="abWinnerCriteria !== 'manual'">
						<label for="abTestDuration" class="label flex items-center gap-2">
							<Icon name="lucide:clock" class="w-4 h-4 text-text-tertiary" />
							Test Duration (hours)
						</label>
						<div class="flex items-center gap-4 mt-1.5">
							<select id="abTestDuration" v-model="abTestDuration" class="input">
								<option :value="1">1 hour</option>
								<option :value="2">2 hours</option>
								<option :value="4">4 hours</option>
								<option :value="8">8 hours</option>
								<option :value="12">12 hours</option>
								<option :value="24">24 hours</option>
							</select>
						</div>
						<p class="mt-1.5 text-sm text-text-tertiary">
							After this time, the winning variant will automatically be sent to the remaining
							{{ Math.max(0, 100 - 2 * abSplitPercentage) }}% of your audience.
						</p>
					</div>
				</div>
			</div>

			<!-- Actions -->
			<div class="flex items-center justify-between mt-8 pt-6 border-t border-border-subtle">
				<UiButton variant="secondary" @click="emit('back')">
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4" /></template>
					Back
				</UiButton>
				<UiButton
					type="submit"
					:loading="isLoading"
					:disabled="
						isLoading ||
						(abTestEnabled && abTestType === 'subject' && !abVariantBSubject.trim()) ||
						(abTestEnabled && abTestType === 'content' && !abVariantBTemplateId)
					"
				>
					{{ isLoading ? 'Saving...' : 'Next' }}
					<template v-if="!isLoading" #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4" /></template>
				</UiButton>
			</div>
		</form>
	</div>
</template>
