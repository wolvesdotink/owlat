<script setup lang="ts">
/**
 * My settings → General: how the app looks, which language it speaks, and how
 * mail reads. Nothing else.
 *
 * This page used to open with a grid of cards repeating the sidebar next to it
 * and then run to 4,500 px: sending health, sending, daily brief, sealed mail,
 * shared links, thirty keyboard shortcuts and the mailbox list. Those now live
 * where people look for them — Connected mailboxes, Account, Sign-in and
 * security, and Keyboard shortcuts.
 */
const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.index.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
});

const { isEnabled } = useFeatureFlag();
const hasMail = computed(() => isEnabled('postbox') || isEnabled('mail.external'));
</script>

<template>
	<div>
		<p class="mb-6 text-text-secondary">{{ t('dashboard.preferences.index.subtitle') }}</p>

		<!-- `id`s are the settings registry's own control anchors, so a palette
		     deep link ("dark mode", "auto-advance") lands on the right card. -->
		<PreferencesAppearance id="appearance" class="scroll-mt-6" />

		<PreferencesLanguage id="language" class="scroll-mt-6" />

		<template v-if="hasMail">
			<PreferencesReading id="reading" class="scroll-mt-6" />

			<!-- Reading protections: the senders whose remote images load without
			     asking. Self-hides until the reader has granted at least one. -->
			<PostboxTrustedSendersSettings />
		</template>
	</div>
</template>
