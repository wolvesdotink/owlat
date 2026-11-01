<script setup lang="ts">
// One step on the builder's canvas. The title is the button that opens it; the
// card click is a larger target for the pointer. The handle reorders it (pointer
// drag through the page's draggable list, or Space / arrows / Space from the
// keyboard), and the actions menu moves or deletes it.
import { stepEditorModuleFor, type StepKind } from '~/composables/automations/steps';

defineProps<{
	step: { _id: string; stepType: string };
	/** Zero-based position on the canvas. */
	index: number;
	total: number;
	selected: boolean;
	lifted: boolean;
	menuOpen: boolean;
	description: string;
}>();

const emit = defineEmits<{
	select: [];
	handleKeydown: [event: KeyboardEvent];
	'update:menuOpen': [open: boolean];
	move: [delta: -1 | 1];
	delete: [];
}>();

const { t } = useI18n();

// Per-step display — resolved through the step editor module registry.
const stepInfo = (stepType: string) => {
	const module = stepEditorModuleFor(stepType as StepKind);
	return { label: module.label, icon: module.icon };
};

// Builder-local accent palette per step kind. Lives here (not on the module)
// because the funnel page in `[id]/index.vue` uses a different palette for the
// same kinds. Adding a step kind to `StepKind` surfaces the missing entry as a
// compile error here.
type StepAccent = {
	readonly iconClass: string;
	readonly pill: { readonly bg: string; readonly border: string; readonly text: string } | null;
};

const STEP_ACCENT: Readonly<Record<StepKind, StepAccent>> = {
	email: { iconClass: 'text-brand bg-brand/10', pill: null },
	delay: {
		iconClass: 'text-brand bg-brand/10',
		pill: { bg: 'bg-brand/10', border: 'border-brand/30', text: 'text-brand' },
	},
	condition: {
		iconClass: 'text-warning bg-warning/10',
		pill: { bg: 'bg-warning/10', border: 'border-warning/30', text: 'text-warning' },
	},
};

const stepAccent = (stepType: string): StepAccent => STEP_ACCENT[stepType as StepKind];
</script>

<template>
	<div
		:class="[
			'card p-4 cursor-pointer transition-[border-color,box-shadow] has-[.step-title:focus-visible]:ring-2 has-[.step-title:focus-visible]:ring-brand',
			selected ? 'ring-2 ring-brand border-brand' : 'hover:border-border-default',
			lifted ? 'ring-2 ring-brand/60 shadow-lg' : '',
		]"
		@click="emit('select')"
	>
		<div class="flex items-center gap-3">
			<!-- Drag handle: pointer drag, or Space / arrows / Space from the keyboard -->
			<button
				type="button"
				class="drag-handle cursor-grab active:cursor-grabbing p-1 -ml-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:class="lifted ? 'text-brand' : 'text-text-tertiary hover:text-text-secondary'"
				:aria-label="t('dashboard.automations.detail.edit.reorder.handle', { number: index + 1 })"
				:aria-pressed="lifted"
				aria-describedby="step-reorder-instructions"
				:data-step-handle="step._id"
				@click.stop
				@keydown="emit('handleKeydown', $event)"
			>
				<Icon name="lucide:grip-vertical" class="w-4 h-4" />
			</button>

			<!-- Step Icon (resolved via the step editor module registry;
					builder-local accent palette via STEP_ACCENT) -->
			<div
				:class="[
					'p-2 rounded-lg flex items-center justify-center',
					stepAccent(step.stepType).iconClass,
				]"
			>
				<Icon :name="stepInfo(step.stepType).icon" class="w-5 h-5" />
			</div>

			<!-- Step Content -->
			<div class="flex-1 min-w-0">
				<button
					type="button"
					class="step-title block text-left focus-visible:outline-none"
					:aria-current="selected ? 'step' : undefined"
					:data-step-title="step._id"
					@click.stop="emit('select')"
				>
					<span class="block text-xs font-medium text-text-tertiary uppercase tracking-wide">
						{{ t('dashboard.automations.detail.edit.stepNumber', { number: index + 1 }) }}
					</span>
					<span class="block font-medium text-text-primary">
						{{ t(stepInfo(step.stepType).label) }}
					</span>
				</button>
				<!-- Description: plain text when no pill accent, pill chrome when defined. -->
				<p v-if="!stepAccent(step.stepType).pill" class="text-sm text-text-secondary truncate">
					{{ description }}
				</p>
				<div v-else class="mt-2">
					<div
						:class="[
							'inline-flex items-center gap-2 px-3 py-1.5 rounded-full border',
							stepAccent(step.stepType).pill!.bg,
							stepAccent(step.stepType).pill!.border,
						]"
					>
						<Icon
							:name="stepInfo(step.stepType).icon"
							:class="['w-3.5 h-3.5', stepAccent(step.stepType).pill!.text]"
						/>
						<span :class="['text-sm font-medium', stepAccent(step.stepType).pill!.text]">
							{{ description }}
						</span>
					</div>
				</div>
			</div>

			<!-- Step actions -->
			<div @click.stop>
				<UiDropdownMenu :open="menuOpen" @update:open="emit('update:menuOpen', $event)">
					<template #trigger>
						<button
							type="button"
							class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							:aria-label="
								t('dashboard.automations.detail.edit.reorder.actions', {
									number: index + 1,
								})
							"
						>
							<Icon name="lucide:more-vertical" class="w-4 h-4" />
						</button>
					</template>
					<UiDropdownMenuItem
						icon="lucide:arrow-up"
						:disabled="index === 0"
						@click="emit('move', -1)"
					>
						{{ t('dashboard.automations.detail.edit.reorder.moveUp') }}
					</UiDropdownMenuItem>
					<UiDropdownMenuItem
						icon="lucide:arrow-down"
						:disabled="index === total - 1"
						@click="emit('move', 1)"
					>
						{{ t('dashboard.automations.detail.edit.reorder.moveDown') }}
					</UiDropdownMenuItem>
					<UiDropdownDivider />
					<UiDropdownMenuItem icon="lucide:trash-2" danger @click="emit('delete')">
						{{ t('common.delete') }}
					</UiDropdownMenuItem>
				</UiDropdownMenu>
			</div>
		</div>
	</div>
</template>
