<script setup lang="ts">
/**
 * My settings → Keyboard shortcuts: the named map this person drives the app
 * with, plus their own remaps on top, for every surface the app has.
 *
 * Not behind the mail flags: the app-wide keys, the Team inbox and the
 * Workbench have shortcuts too. The rows follow the instance's features, and
 * the Help overlay shows the same map, read-only. The intro names the key that
 * opens it as the person has it bound, and leaves the sentence out when Help
 * is unbound.
 */
import PreferencesShortcuts from '~/components/preferences/PreferencesShortcuts.vue';
import { useShortcutLabels } from '~/composables/useShortcutLabels';

const { t } = useI18n();
const { labelParams } = useShortcutLabels();
const helpParams = computed(() => labelParams({ key: 'global.help' }));

useHead({ title: () => t('dashboard.preferences.shortcuts.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
});
</script>

<template>
	<div>
		<p class="mb-6 text-text-secondary">
			{{ t('dashboard.preferences.shortcuts.intro') }}
			<template v-if="helpParams">{{
				t('dashboard.preferences.shortcuts.introHelp', helpParams)
			}}</template>
		</p>

		<PreferencesShortcuts />
	</div>
</template>
