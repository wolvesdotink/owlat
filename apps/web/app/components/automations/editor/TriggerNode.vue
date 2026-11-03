<script setup lang="ts">
// The builder's first node: the trigger card (with its summary and the Edit
// link back to the trigger picker), then the "+" that adds a step at the top.
import type { Doc } from '@owlat/api/dataModel';
import { triggerEditorModuleFor, type TriggerKind } from '~/composables/automations/triggers';
import type { StepKind } from '~/composables/automations/steps';
import { getIconColorClass, getTriggerInfo } from '~/composables/automations/editorDisplay';
import { useLocalized } from '~/composables/useLocalized';
import type { LocalizedText } from '~/utils/localizedText';
import AddStepMenu from '~/components/automations/editor/AddStepMenu.vue';

const props = defineProps<{
	automation: { _id: string; triggerType: string; triggerConfig?: unknown };
	topics: Doc<'topics'>[] | undefined;
	addStepOpen: boolean;
	stepTypes: ReadonlyArray<{ id: StepKind; label: string; description: string; color: string }>;
}>();

const emit = defineEmits<{ toggleAddStep: []; addStep: [stepType: StepKind] }>();

const { t } = useI18n();

const topicsRef = computed(() => props.topics ?? []);
// The trigger registry hands back translatable text rather than a finished
// sentence: a bare key for a constant summary, `{ key, params }` for a
// parameterized one.
const renderRegistrySummary = useLocalized();

const triggerSummary = computed(() => {
	if (!props.automation.triggerConfig) return '';
	const module = triggerEditorModuleFor(props.automation.triggerType as TriggerKind);
	return renderRegistrySummary(
		(module.getSummary as (c: unknown, ctx: { topics: typeof topicsRef }) => LocalizedText)(
			props.automation.triggerConfig,
			{ topics: topicsRef }
		)
	);
});
</script>

<template>
	<div class="relative">
		<!-- Trigger Card -->
		<div class="card p-4">
			<div class="flex items-center gap-3">
				<div
					:class="[
						'p-2 rounded-lg',
						getIconColorClass(getTriggerInfo(automation.triggerType).color),
					]"
				>
					<component :is="getTriggerInfo(automation.triggerType).icon" class="w-5 h-5" />
				</div>
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						<span class="text-xs font-medium text-text-tertiary uppercase tracking-wide">{{
							t('dashboard.automations.detail.edit.trigger')
						}}</span>
					</div>
					<p class="font-medium text-text-primary">
						{{ t(getTriggerInfo(automation.triggerType).label) }}
					</p>
					<p v-if="automation.triggerConfig" class="text-sm text-text-secondary truncate">
						{{ triggerSummary }}
					</p>
				</div>
				<NuxtLink
					:to="`/dashboard/automations/new?edit=${automation._id}`"
					class="text-sm text-brand hover:underline"
				>
					{{ t('common.edit') }}
				</NuxtLink>
			</div>
		</div>

		<!-- Connector Line -->
		<div class="flex flex-col items-center">
			<div class="w-0.5 h-4 bg-border-default" />

			<!-- Add Step Button (at start) -->
			<AddStepMenu
				:open="addStepOpen"
				:step-types="stepTypes"
				@toggle="emit('toggleAddStep')"
				@add="emit('addStep', $event)"
			/>

			<div class="w-0.5 h-4 bg-border-default" />
		</div>
	</div>
</template>
