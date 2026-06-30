<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ABTestType, ABWinnerCriteria } from '~/composables/useCampaignABTest';

const props = defineProps<{
	/** The current campaign subject line (for Variant A display) */
	campaignSubject: string;
	/** The selected template for Variant A (name display) */
	selectedTemplateName?: string;
	/** Available email templates for Variant B content selection */
	emailTemplates?: Array<{ _id: Id<'emailTemplates'>; name: string }> | null;
	/** The currently selected template ID (to exclude from Variant B options) */
	selectedTemplateId: Id<'emailTemplates'> | null;
}>();

// A/B test state is passed via v-model bindings
const abTestEnabled = defineModel<boolean>('abTestEnabled', { required: true });
const abTestType = defineModel<ABTestType>('abTestType', { required: true });
const abVariantBSubject = defineModel<string>('abVariantBSubject', { required: true });
const abVariantBTemplateId = defineModel<Id<'emailTemplates'> | null>('abVariantBTemplateId', { required: true });
const abSplitPercentage = defineModel<number>('abSplitPercentage', { required: true });
const abWinnerCriteria = defineModel<ABWinnerCriteria>('abWinnerCriteria', { required: true });
const abTestDuration = defineModel<number>('abTestDuration', { required: true });

const filteredTemplates = computed(() => {
	if (!props.emailTemplates) return [];
	return props.emailTemplates.filter((t) => t._id !== props.selectedTemplateId);
});
</script>

<template>
	<div class="card p-6">
		<h2 class="text-lg font-semibold text-text-primary mb-6">A/B Testing</h2>

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
					<div class="grid grid-cols-2 gap-4">
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
								<p class="font-medium text-text-primary">Subject Line</p>
								<p class="text-sm text-text-secondary mt-0.5">Test different subject lines</p>
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
								<p class="font-medium text-text-primary">Email Content</p>
								<p class="text-sm text-text-secondary mt-0.5">
									Test different email templates
								</p>
							</div>
						</label>
					</div>
				</div>

				<!-- Variant A (Current) -->
				<div class="p-4 bg-bg-surface border border-border-subtle rounded-lg">
					<div class="flex items-center gap-2 mb-2">
						<div
							class="w-6 h-6 rounded-full bg-brand/20 text-brand flex items-center justify-center text-xs font-bold"
						>
							A
						</div>
						<span class="font-medium text-text-primary">Variant A (Original)</span>
					</div>
					<p class="text-sm text-text-secondary ml-8">
						{{ abTestType === 'subject' ? campaignSubject : selectedTemplateName }}
					</p>
				</div>

				<!-- Variant B Configuration -->
				<div class="p-4 bg-bg-surface border border-border-subtle rounded-lg">
					<div class="flex items-center gap-2 mb-3">
						<div
							class="w-6 h-6 rounded-full bg-brand/20 text-brand flex items-center justify-center text-xs font-bold"
						>
							B
						</div>
						<span class="font-medium text-text-primary">Variant B</span>
					</div>

					<!-- Subject Line B (for subject tests) -->
					<div v-if="abTestType === 'subject'" class="ml-8">
						<label for="abVariantBSubject" class="label flex items-center gap-2">
							<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary" />
							Subject Line B
						</label>
						<input
							id="abVariantBSubject"
							v-model="abVariantBSubject"
							type="text"
							placeholder="e.g., Don't miss out on this special offer!"
							class="input mt-1.5"
						/>
					</div>

					<!-- Template B (for content tests) -->
					<div v-else class="ml-8">
						<label for="abVariantBTemplate" class="label flex items-center gap-2">
							<Icon name="lucide:file-text" class="w-4 h-4 text-text-tertiary" />
							Email Template B
						</label>
						<select
							id="abVariantBTemplate"
							v-model="abVariantBTemplateId"
							class="input mt-1.5"
						>
							<option :value="null" disabled>Select a template...</option>
							<option
								v-for="template in filteredTemplates"
								:key="template._id"
								:value="template._id"
							>
								{{ template.name }}
							</option>
						</select>
					</div>
				</div>

				<!-- Split Percentage -->
				<div>
					<label class="label flex items-center gap-2">
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
					<label class="label flex items-center gap-2">
						<Icon name="lucide:check-circle" class="w-4 h-4 text-text-tertiary" />
						How should we pick the winner?
					</label>
					<div class="grid grid-cols-3 gap-3 mt-2">
						<label
							:class="[
								'flex flex-col items-center p-4 border rounded-lg cursor-pointer transition-colors text-center',
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
							<Icon name="lucide:eye" class="w-5 h-5 text-brand mb-2" />
							<span class="text-sm font-medium text-text-primary">Open Rate</span>
							<span class="text-xs text-text-tertiary mt-1">Most opens wins</span>
						</label>
						<label
							:class="[
								'flex flex-col items-center p-4 border rounded-lg cursor-pointer transition-colors text-center',
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
							<Icon name="lucide:mail" class="w-5 h-5 text-brand mb-2" />
							<span class="text-sm font-medium text-text-primary">Click Rate</span>
							<span class="text-xs text-text-tertiary mt-1">Most clicks wins</span>
						</label>
						<label
							:class="[
								'flex flex-col items-center p-4 border rounded-lg cursor-pointer transition-colors text-center',
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
							<Icon name="lucide:pencil" class="w-5 h-5 text-brand mb-2" />
							<span class="text-sm font-medium text-text-primary">Manual</span>
							<span class="text-xs text-text-tertiary mt-1">You decide</span>
						</label>
					</div>
				</div>

				<!-- Test Duration (for auto winner selection) -->
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
							<option :value="6">6 hours</option>
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
	</div>
</template>
