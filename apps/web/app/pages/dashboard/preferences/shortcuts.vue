<script setup lang="ts">
/**
 * My settings → Keyboard shortcuts: the named map this person drives the app
 * with, plus their own remaps on top, for every surface the app has.
 *
 * Not behind the mail flags: the app-wide keys, the Team inbox and the
 * Workbench have shortcuts too. The rows follow the instance's features, and
 * the `?` overlay shows the same map, read-only.
 */
import PreferencesShortcuts from '~/components/preferences/PreferencesShortcuts.vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.shortcuts.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
});
</script>

<template>
	<div>
		<p class="mb-6 text-text-secondary">{{ t('dashboard.preferences.shortcuts.intro') }}</p>

		<PreferencesShortcuts />
	</div>
</template>
