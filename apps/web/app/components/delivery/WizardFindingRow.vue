<script setup lang="ts">
/**
 * One result row of the transport connection wizard (P2-4): status glyph, label,
 * detail, and — when there is something to do — the exact change to make.
 *
 * One component rather than the same markup in the alignment list and the
 * return-path panel, so the row's shape (and its accessible name) cannot change
 * in one place only.
 *
 * Accessibility: the icon is decorative and hidden; the status is spoken as a
 * word from the shared presentation map, because colour plus a glyph tells a
 * screen-reader user nothing.
 */
import { computed } from 'vue';
import { FINDING_PRESENTATION, type WizardFinding } from '~/utils/transportWizard';

const props = defineProps<{ finding: WizardFinding }>();

const presentation = computed(() => FINDING_PRESENTATION[props.finding.status]);
</script>

<template>
	<div class="flex items-start gap-3 rounded-lg border border-border-subtle p-3">
		<Icon
			:name="presentation.icon"
			class="w-4 h-4 mt-0.5 shrink-0"
			:class="presentation.class"
			aria-hidden="true"
		/>
		<div class="min-w-0">
			<p class="text-sm font-medium text-text-primary">
				<span class="sr-only">{{ presentation.srLabel }}</span>
				{{ finding.label }}
			</p>
			<p class="text-sm text-text-secondary">{{ finding.detail }}</p>
			<p v-if="finding.remedy" class="text-sm text-text-primary mt-1">{{ finding.remedy }}</p>
		</div>
	</div>
</template>
