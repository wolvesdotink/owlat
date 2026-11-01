<script setup lang="ts">
// The builder's round "+" between nodes and its "Add step" menu. Clicks stop
// here, so the page's outside-click handler does not close the menu at once.
import type { StepKind } from '~/composables/automations/steps';
import { getIconColorClass } from '~/composables/automations/editorDisplay';

defineProps<{
	open: boolean;
	stepTypes: ReadonlyArray<{ id: StepKind; label: string; description: string; color: string }>;
	/** Set on the menu panel, for tests that find one particular menu. */
	menuTestId?: string;
}>();

const emit = defineEmits<{ toggle: []; add: [stepType: StepKind] }>();

const { t } = useI18n();
</script>

<template>
	<div class="relative" @click.stop>
		<button
			class="flex items-center justify-center w-8 h-8 rounded-full bg-bg-surface border border-border-default text-text-tertiary hover:text-brand hover:border-brand transition-colors"
			@click="emit('toggle')"
			:aria-label="t('common.add')"
		>
			<Icon name="lucide:plus" class="w-4 h-4" />
		</button>

		<!-- Dropdown -->
		<div
			v-if="open"
			:data-testid="menuTestId"
			class="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg z-20"
		>
			<div class="p-2">
				<p class="text-xs font-medium text-text-tertiary uppercase tracking-wide px-2 py-1">
					{{ t('dashboard.automations.detail.edit.addStep') }}
				</p>
				<button
					v-for="type in stepTypes"
					:key="type.id"
					class="flex items-center gap-3 w-full p-2 rounded-lg text-left transition-colors hover:bg-bg-surface"
					@click="emit('add', type.id)"
				>
					<div
						:class="[
							'p-2 rounded-lg flex items-center justify-center',
							getIconColorClass(type.color),
						]"
					>
						<Icon
							:name="
								type.id === 'email'
									? 'lucide:mail'
									: type.id === 'delay'
										? 'lucide:clock'
										: 'lucide:git-branch'
							"
							class="w-4 h-4"
						/>
					</div>
					<div class="flex-1 min-w-0">
						<p class="font-medium text-text-primary text-sm">{{ t(type.label) }}</p>
						<p class="text-xs text-text-secondary">{{ t(type.description) }}</p>
					</div>
				</button>
			</div>
		</div>
	</div>
</template>
