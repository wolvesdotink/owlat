<script setup lang="ts">
/**
 * The runs panel's sentence for one failure reason or one wait reason, alone:
 * the automations list puts it under a count. Loaded only when a row has a
 * failure or a wait to explain, so the reasons map and the fix-link catalog
 * behind it stay out of the list's first load.
 */
import { runFailureNote, type AutomationRunFailure } from '~/lib/automationRunFailure';
import { formatDateTime } from '~/utils/formatters';

const props = defineProps<{ failure: AutomationRunFailure; automationId: string }>();

const { t } = useI18n();

const message = computed(() =>
	t(runFailureNote(props.failure, props.automationId).messageKey, {
		date: formatDateTime(props.failure.until),
	})
);
</script>

<template>
	<span :title="message">{{ message }}</span>
</template>
