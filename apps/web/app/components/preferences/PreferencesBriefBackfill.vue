<script setup lang="ts">
/**
 * "Prepare overviews for recent mail" (ADR-0072, D5): the owner starts the
 * thread brief's backfill of their personal mailbox, the active
 * conversations of the last 30 days, and sees how far it got. A walk the
 * spend budget or the per-run cap paused, or one they stopped, resumes from
 * where it was. Older threads are prepared on first open instead.
 */
import { useBriefBackfill } from '~/composables/threadBrief/useBriefBackfill';

const { t } = useI18n();
const { inboxes } = useInboxes();
const mailboxId = computed(
	() => inboxes.value.find((inbox) => inbox.scope === 'personal')?.mailboxId ?? null
);
const { status, start, cancel, isBusy } = useBriefBackfill(() => mailboxId.value);

const isRunning = computed(() => status.value?.status === 'running');
const canResume = computed(
	() => status.value?.status === 'paused' || status.value?.status === 'cancelled'
);
const note = computed(() => {
	const s = status.value;
	if (!s) return null;
	const count = s.threadCount;
	switch (s.status) {
		case 'running':
			return t('components.preferences.preferencesReading.backfillRunning', { count }, count);
		case 'completed':
			return t('components.preferences.preferencesReading.backfillDone', { count }, count);
		case 'cancelled':
			return t('components.preferences.preferencesReading.backfillCancelled');
		case 'paused':
			if (s.pausedReason === 'budget')
				return t('components.preferences.preferencesReading.backfillPausedBudget');
			if (s.pausedReason === 'ai_off')
				return t('components.preferences.preferencesReading.backfillPausedOff');
			return t('components.preferences.preferencesReading.backfillPausedCap', { count });
	}
	return null;
});
</script>

<template>
	<div
		v-if="mailboxId"
		class="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 border-t border-border-subtle"
		data-testid="brief-backfill"
	>
		<div class="min-w-0">
			<p class="font-medium text-sm">
				{{ t('components.preferences.preferencesReading.backfillLabel') }}
			</p>
			<p class="text-xs text-text-tertiary mt-0.5">
				{{ t('components.preferences.preferencesReading.backfillHelp') }}
			</p>
			<p v-if="note" class="text-xs text-text-secondary mt-1" data-testid="brief-backfill-note">
				{{ note }}
			</p>
		</div>
		<UiButton v-if="isRunning" variant="secondary" size="sm" @click="cancel">
			{{ t('components.preferences.preferencesReading.backfillCancel') }}
		</UiButton>
		<UiButton v-else variant="secondary" size="sm" :loading="isBusy" @click="start">
			{{
				canResume
					? t('components.preferences.preferencesReading.backfillResume')
					: t('components.preferences.preferencesReading.backfillStart')
			}}
		</UiButton>
	</div>
</template>
