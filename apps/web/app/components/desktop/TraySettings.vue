<script setup lang="ts">
/**
 * The tray icon's device settings (src-tauri tray.rs): whether it is shown,
 * and on Windows and Linux whether closing the main window keeps Owlat
 * running in it. macOS always keeps the app running when the window closes,
 * so that row is not offered there. Without the icon closing quits, since
 * nothing would be left on screen to bring the window back; the row is
 * disabled then.
 */
import { defaultDesktopSettings, type GlobalDesktopSettings } from '~/lib/desktop/settingsTypes';
import SettingsResetToDefault from '~/components/settings/ResetToDefault.vue';

const { t } = useI18n();
const { isMac } = useDesktopContext();
const { settings, isReady, setGlobal } = useDesktopAppSettings();

const DEFAULTS = defaultDesktopSettings().global;

function isChanged(key: 'showTrayIcon' | 'closeToTray'): boolean {
	return isReady.value && settings.value.global[key] !== DEFAULTS[key];
}

function reset(key: keyof GlobalDesktopSettings) {
	setGlobal(key, DEFAULTS[key]);
}

// macOS calls it the menu bar; Windows and Linux the system tray.
const iconCopy = computed(() =>
	isMac.value
		? {
				heading: t('desktop.settings.tray.menuBarIcon.heading'),
				title: t('desktop.settings.tray.menuBarIcon.title'),
				description: t('desktop.settings.tray.menuBarIcon.description'),
			}
		: {
				heading: t('desktop.settings.tray.trayIcon.heading'),
				title: t('desktop.settings.tray.trayIcon.title'),
				description: t('desktop.settings.tray.trayIcon.description'),
			}
);
</script>

<template>
	<section id="tray" class="card !p-0 mb-6 scroll-mt-6 overflow-hidden">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">{{ iconCopy.heading }}</h2>
		</header>
		<div class="flex items-center justify-between gap-4 px-5 py-4">
			<span>
				<span class="flex items-center gap-2">
					<label for="desktop-tray-icon" class="block text-sm font-medium">{{
						iconCopy.title
					}}</label>
					<SettingsResetToDefault
						:changed="isChanged('showTrayIcon')"
						:label="iconCopy.title"
						:disabled="!isReady"
						@reset="reset('showTrayIcon')"
					/>
				</span>
				<span class="block text-xs text-text-tertiary">{{ iconCopy.description }}</span>
			</span>
			<UiSwitch
				id="desktop-tray-icon"
				:model-value="settings.global.showTrayIcon"
				:disabled="!isReady"
				@update:model-value="setGlobal('showTrayIcon', $event)"
			/>
		</div>
		<div
			v-if="!isMac"
			class="flex items-center justify-between gap-4 border-t border-border-subtle px-5 py-4"
		>
			<span>
				<span class="flex items-center gap-2">
					<label for="desktop-close-to-tray" class="block text-sm font-medium">{{
						t('desktop.settings.tray.closeToTray.title')
					}}</label>
					<SettingsResetToDefault
						:changed="isChanged('closeToTray')"
						:label="t('desktop.settings.tray.closeToTray.title')"
						:disabled="!isReady"
						@reset="reset('closeToTray')"
					/>
				</span>
				<span class="block text-xs text-text-tertiary">{{
					settings.global.showTrayIcon
						? t('desktop.settings.tray.closeToTray.description')
						: t('desktop.settings.tray.closeToTray.needsIcon')
				}}</span>
			</span>
			<UiSwitch
				id="desktop-close-to-tray"
				:model-value="settings.global.showTrayIcon && settings.global.closeToTray"
				:disabled="!isReady || !settings.global.showTrayIcon"
				@update:model-value="setGlobal('closeToTray', $event)"
			/>
		</div>
	</section>
</template>
