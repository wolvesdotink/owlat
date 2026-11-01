<script setup lang="ts">
/**
 * "AI safety check not run" on a Team inbox message: the message
 * was archived as spam, or arrived while the agent was off, so the model
 * guard was skipped and recorded as skipped. Says which, and that the check
 * runs before the agent acts on the message. Presentational.
 */
import { GUARD_NOT_RUN_REASON_KEYS, type GuardNotRunMarker } from '~/utils/guardNotRun';
import { formatDateTime } from '~/utils/formatters';
import { ShieldHelpIcon } from '@coolicons/vue';

const props = defineProps<{ marker: GuardNotRunMarker }>();

const { t } = useI18n();
const recordedAt = computed(() => formatDateTime(props.marker.at));
</script>

<template>
	<div
		class="mt-4 flex items-start gap-2 rounded-lg bg-bg-surface-hover p-3"
		role="note"
		data-testid="thread-guard-not-run"
		:data-reason="marker.reason"
	>
		<ShieldHelpIcon class="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
		<div class="min-w-0 text-xs">
			<p class="font-medium text-text-primary">{{ t('components.inbox.guardNotRun.title') }}</p>
			<p class="mt-0.5 text-text-secondary">{{ t(GUARD_NOT_RUN_REASON_KEYS[marker.reason]) }}</p>
			<p class="mt-0.5 text-text-tertiary">
				{{ t('components.inbox.guardNotRun.recordedAt', { date: recordedAt }) }}
			</p>
		</div>
	</div>
</template>
