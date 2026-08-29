<script setup lang="ts">
/**
 * The one-time "your mail is sealed" strip (plan idea 55).
 *
 * When an instance turns Sealed Mail on, the only thing that changes for a
 * member is that small lock glyphs start appearing on their mail. Nobody
 * explains what happened, and the recovery kit — the ONE thing whose absence is
 * unrecoverable — sits on a settings page nobody has a reason to open. So this
 * says it once, above the list, and points at that page.
 *
 * Once. Dismissing stamps `sealedMailNudgeSeenAt`, which is a per-user server
 * preference rather than local storage precisely because "shown once" has to
 * mean once per person, not once per browser. Following the link dismisses it
 * too: the nudge exists to get someone to that page, so arriving is its job
 * done.
 */
const { t } = useI18n();
const { isEnabled } = useFeatureFlag();
const { hasSeenSealedMailNudge, dismissSealedMailNudge } = usePostboxSettings();

const isVisible = computed(() => isEnabled('sealedMail') && !hasSeenSealedMailNudge.value);

async function dismiss() {
	await dismissSealedMailNudge();
}

async function openSettings() {
	await dismissSealedMailNudge();
	await navigateTo('/dashboard/preferences#sealed-mail');
}
</script>

<template>
	<div
		v-if="isVisible"
		class="flex items-start gap-2 px-4 py-2 bg-success-subtle text-text-secondary text-xs border-b border-border-subtle"
		role="status"
		data-testid="sealed-mail-nudge"
	>
		<Icon name="lucide:lock" class="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-success" />
		<p class="min-w-0 flex-1">
			{{ t('components.postbox.postboxSealedMailNudge.body') }}
			<button
				type="button"
				class="underline hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
				data-testid="sealed-mail-nudge-open"
				@click="openSettings"
			>
				{{ t('components.postbox.postboxSealedMailNudge.action') }}
			</button>
		</p>
		<button
			type="button"
			class="p-0.5 rounded text-text-tertiary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
			:aria-label="t('common.dismiss')"
			data-testid="sealed-mail-nudge-dismiss"
			@click="dismiss"
		>
			<Icon name="lucide:x" class="w-3.5 h-3.5" />
		</button>
	</div>
</template>
