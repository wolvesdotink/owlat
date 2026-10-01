<script setup lang="ts">
/**
 * One line that says whether the open step's edits are on the server.
 *
 * Step editors save on every change, so this replaces the old "Save changes"
 * button: the inspector footer carries it, and the page header mirrors it so a
 * failed save stays visible while the inspector is scrolled or closed. Only
 * the footer copy is a live region, so a screen reader hears each change once.
 */
import type { StepSaveStatus } from '~/composables/useAutomationStepConfig';

defineProps<{
	status: StepSaveStatus;
	/** Announce changes (the inspector footer); the header mirror stays quiet. */
	live?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

const { t } = useI18n();
</script>

<template>
	<div
		class="flex items-center gap-1.5 text-sm"
		:class="status === 'error' ? 'text-error' : 'text-text-secondary'"
		:role="live ? 'status' : undefined"
		data-testid="step-save-status"
		:data-status="status"
	>
		<template v-if="status === 'saving'">
			<Icon name="lucide:loader-2" class="w-4 h-4 animate-spin motion-reduce:animate-none" />
			<span>{{ t('components.automations.stepSaveStatus.saving') }}</span>
		</template>
		<template v-else-if="status === 'error'">
			<Icon name="lucide:alert-circle" class="w-4 h-4 shrink-0" />
			<span>{{ t('components.automations.stepSaveStatus.error') }}</span>
			<button
				type="button"
				class="font-medium underline underline-offset-2 rounded hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				@click="emit('retry')"
			>
				{{ t('components.automations.stepSaveStatus.retry') }}
			</button>
		</template>
		<template v-else>
			<Icon name="lucide:check" class="w-4 h-4" />
			<span>{{ t('components.automations.stepSaveStatus.saved') }}</span>
		</template>
	</div>
</template>
