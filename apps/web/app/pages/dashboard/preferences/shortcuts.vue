<script setup lang="ts">
/**
 * My settings → Keyboard shortcuts: the named map this person drives the app
 * with, plus their own remaps on top.
 *
 * Thirty rows of key bindings used to sit in the middle of General. They get a
 * page of their own; the `?` overlay shows the same map, read-only.
 */
const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.shortcuts.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});
</script>

<template>
	<div>
		<p class="mb-6 text-text-secondary">{{ t('dashboard.preferences.shortcuts.intro') }}</p>

		<PostboxShortcutSettings />
	</div>
</template>
