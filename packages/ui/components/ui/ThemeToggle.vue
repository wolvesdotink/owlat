<script setup lang="ts">
/**
 * Theme toggle button that cycles through System -> Light -> Dark.
 *
 * Uses @nuxtjs/color-mode under the hood. The preference is persisted
 * automatically via the color-mode module's localStorage key.
 */
import { MonitorIcon, MoonIcon, SunIcon } from '@coolicons/vue';
import { useUiI18n } from '../../composables/useUiI18n';
import UiTooltip from './Tooltip.vue';

type ThemeMode = 'system' | 'light' | 'dark';

const { t } = useUiI18n();
const colorMode = useColorMode();

const current = computed<ThemeMode>(() => {
	const pref = colorMode.preference;
	if (pref === 'light' || pref === 'dark') return pref;
	return 'system';
});

const label = computed(() => {
	switch (current.value) {
		case 'light':
			return t('ui.themeToggle.light');
		case 'dark':
			return t('ui.themeToggle.dark');
		default:
			return t('ui.themeToggle.system');
	}
});

const ariaLabel = computed(() => t('ui.themeToggle.ariaLabel', { mode: label.value }));

function cycle() {
	const order: ThemeMode[] = ['system', 'light', 'dark'];
	const next = order[(order.indexOf(current.value) + 1) % order.length] as ThemeMode;
	colorMode.preference = next;
}
</script>

<template>
	<UiTooltip :text="label">
		<button :aria-label="ariaLabel" @click="cycle">
			<MonitorIcon v-if="current === 'system'" class="w-[18px] h-[18px]" />
			<SunIcon v-else-if="current === 'light'" class="w-[18px] h-[18px]" />
			<MoonIcon v-else class="w-[18px] h-[18px]" />

			<slot />
		</button>
	</UiTooltip>
</template>
