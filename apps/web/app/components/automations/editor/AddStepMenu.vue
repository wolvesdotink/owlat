<script setup lang="ts">
// The builder's round "+" between nodes and its "Add step" menu. Clicks stop
// here, so the page's outside-click handler does not close the menu at once.
// The page owns which menu is open (one at a time), so this is a disclosure:
// the trigger says whether its list is shown, opening moves focus to the first
// option, and Escape closes it and returns focus to the "+".
import type { StepKind } from '~/composables/automations/steps';
import { getIconColorClass } from '~/composables/automations/editorDisplay';
import { ClockIcon, GitBranchIcon, MailIcon, PlusIcon } from '@coolicons/vue';

const props = defineProps<{
	open: boolean;
	stepTypes: ReadonlyArray<{ id: StepKind; label: string; description: string; color: string }>;
	/** Set on the menu panel, for tests that find one particular menu. */
	menuTestId?: string;
}>();

const emit = defineEmits<{ toggle: []; add: [stepType: StepKind] }>();

const { t } = useI18n();

const menuId = useId();
const triggerRef = ref<HTMLButtonElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);

watch(
	() => props.open,
	async (open) => {
		if (!open) return;
		await nextTick();
		panelRef.value?.querySelector<HTMLButtonElement>('button')?.focus();
	}
);

function closeOnEscape() {
	if (!props.open) return;
	emit('toggle');
	triggerRef.value?.focus();
}
</script>

<template>
	<div class="relative" @click.stop @keydown.esc="closeOnEscape">
		<button
			ref="triggerRef"
			type="button"
			class="flex items-center justify-center w-8 h-8 rounded-full bg-bg-surface border border-border-default text-text-tertiary hover:text-brand hover:border-brand transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base pointer-coarse:size-11"
			:aria-label="t('dashboard.automations.detail.edit.addStep')"
			:aria-expanded="open"
			:aria-controls="open ? menuId : undefined"
			@click="emit('toggle')"
		>
			<PlusIcon class="w-4 h-4" />
		</button>

		<!-- Dropdown -->
		<div
			v-if="open"
			:id="menuId"
			ref="panelRef"
			:data-testid="menuTestId"
			class="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 max-w-[calc(100vw-2rem)] bg-bg-elevated border border-border-subtle rounded-lg shadow-lg z-20"
		>
			<div class="p-2">
				<p class="text-xs font-medium text-text-tertiary uppercase tracking-wide px-2 py-1">
					{{ t('dashboard.automations.detail.edit.addStep') }}
				</p>
				<button
					v-for="type in stepTypes"
					:key="type.id"
					type="button"
					class="flex items-center gap-3 w-full p-2 rounded-lg text-left transition-colors hover:bg-bg-surface focus-visible:outline-none focus-visible:bg-bg-surface focus-visible:ring-2 focus-visible:ring-brand"
					@click="emit('add', type.id)"
				>
					<span
						:class="[
							'p-2 rounded-lg flex items-center justify-center',
							getIconColorClass(type.color),
						]"
					>
						<component
							:is="type.id === 'email' ? MailIcon : type.id === 'delay' ? ClockIcon : GitBranchIcon"
							class="w-4 h-4"
						/>
					</span>
					<span class="flex-1 min-w-0">
						<span class="block font-medium text-text-primary text-sm">{{ t(type.label) }}</span>
						<span class="block text-xs text-text-secondary">{{ t(type.description) }}</span>
					</span>
				</button>
			</div>
		</div>
	</div>
</template>
