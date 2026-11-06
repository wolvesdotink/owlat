<script setup lang="ts">
/**
 * The tray icon's device settings (src-tauri tray.rs): whether it is shown,
 * which mailbox it counts, on Windows and Linux whether closing the main
 * window keeps Owlat running in it, and on macOS whether the Dock icon goes.
 * macOS always keeps the app running when the window closes, so that row is
 * not offered there. Without the icon closing quits and the Dock icon stays,
 * since nothing would be left on screen to bring the app back; those rows are
 * disabled then.
 *
 * The mailbox is a per-workspace setting: a mailbox id belongs to the backend
 * of one workspace. The row shows once there is a choice to make (two or more
 * inboxes), or a stored choice to undo.
 */
import { defaultDesktopSettings, type GlobalDesktopSettings } from '~/lib/desktop/settingsTypes';
import { getActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import SettingsResetToDefault from '~/components/settings/ResetToDefault.vue';

const { t } = useI18n();
const { isMac } = useDesktopContext();
const { settings, isReady, setGlobal, workspaceLocal, setWorkspaceLocal } = useDesktopAppSettings();
const { inboxes } = useInboxes();

const DEFAULTS = defaultDesktopSettings().global;

function isChanged(key: 'showTrayIcon' | 'closeToTray' | 'hideDockIcon'): boolean {
	return isReady.value && settings.value.global[key] !== DEFAULTS[key];
}

function reset(key: keyof GlobalDesktopSettings) {
	setGlobal(key, DEFAULTS[key]);
}

// Stable for the page load: a workspace switch reloads the webview.
const workspaceId = getActiveWorkspace()?.id ?? null;
const trayMailboxId = computed(() =>
	workspaceId && isReady.value ? workspaceLocal(workspaceId).trayMailboxId : null
);
const showMailboxRow = computed(
	() => workspaceId !== null && (inboxes.value.length > 1 || trayMailboxId.value !== null)
);

function resetMailbox() {
	if (workspaceId) setWorkspaceLocal(workspaceId, 'trayMailboxId', null);
}

function onMailboxChange(event: Event) {
	if (!workspaceId) return;
	const value = (event.target as HTMLSelectElement).value;
	setWorkspaceLocal(workspaceId, 'trayMailboxId', value === '' ? null : value);
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
			v-if="showMailboxRow"
			class="flex items-center justify-between gap-4 border-t border-border-subtle px-5 py-4"
		>
			<span>
				<span class="flex items-center gap-2">
					<label for="desktop-tray-mailbox" class="block text-sm font-medium">{{
						t('desktop.settings.tray.mailbox.title')
					}}</label>
					<SettingsResetToDefault
						:changed="trayMailboxId !== null"
						:label="t('desktop.settings.tray.mailbox.title')"
						:disabled="!isReady"
						@reset="resetMailbox"
					/>
				</span>
				<span class="block text-xs text-text-tertiary">{{
					t('desktop.settings.tray.mailbox.description')
				}}</span>
			</span>
			<select
				id="desktop-tray-mailbox"
				class="input input-sm max-w-[14rem] shrink-0"
				:value="trayMailboxId ?? ''"
				:disabled="!isReady || !settings.global.showTrayIcon"
				@change="onMailboxChange"
			>
				<option value="">{{ t('desktop.settings.tray.mailbox.all') }}</option>
				<option v-for="inbox in inboxes" :key="inbox.mailboxId" :value="inbox.mailboxId">
					{{ inbox.name }}
				</option>
			</select>
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
		<div
			v-if="isMac"
			class="flex items-center justify-between gap-4 border-t border-border-subtle px-5 py-4"
		>
			<span>
				<span class="flex items-center gap-2">
					<label for="desktop-hide-dock-icon" class="block text-sm font-medium">{{
						t('desktop.settings.tray.hideDockIcon.title')
					}}</label>
					<SettingsResetToDefault
						:changed="isChanged('hideDockIcon')"
						:label="t('desktop.settings.tray.hideDockIcon.title')"
						:disabled="!isReady"
						@reset="reset('hideDockIcon')"
					/>
				</span>
				<span class="block text-xs text-text-tertiary">{{
					settings.global.showTrayIcon
						? t('desktop.settings.tray.hideDockIcon.description')
						: t('desktop.settings.tray.hideDockIcon.needsIcon')
				}}</span>
			</span>
			<UiSwitch
				id="desktop-hide-dock-icon"
				:model-value="settings.global.showTrayIcon && settings.global.hideDockIcon"
				:disabled="!isReady || !settings.global.showTrayIcon"
				@update:model-value="setGlobal('hideDockIcon', $event)"
			/>
		</div>
	</section>
</template>
