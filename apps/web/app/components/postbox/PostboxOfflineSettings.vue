<script setup lang="ts">
/**
 * "On this device" — the device-local offline read cache controls.
 *
 * Extracted from the Postbox settings page so that page stays under the
 * file-size ceiling. Owns the "Store recent mail on this device" preference
 * (localStorage, NOT synced), the quota/writes-disabled surface, and the
 * "Clear local cache" action. No mailbox id is threaded here: the toggle is
 * device-global and Clear wipes every mailbox's cache on this device.
 */
import { describeShellStatus } from '~/utils/offlineShell';

const { t } = useI18n();

const { isDesktop } = useDesktopContext();

// Offline START (the service worker) is a different thing from the offline mail
// cache below it: it decides whether the app PAINTS without a connection, and
// it is instance-wide rather than a per-device choice, so it reports rather
// than toggles. `controller` only settles after mount — a page loaded before
// the worker took over is not yet controlled.
const config = useRuntimeConfig();
const shellControlled = ref(false);
onMounted(() => {
	shellControlled.value = !!navigator.serviceWorker?.controller;
});
const shellStatus = computed(() =>
	describeShellStatus({
		supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
		isDesktopBuild: config.public.isDesktopBuild === true,
		isDev: import.meta.dev,
		enabled: config.public.offlineShell !== false,
		controlled: shellControlled.value,
	})
);

const {
	enabled: offlineCacheEnabled,
	setEnabled: setOfflineCacheEnabled,
	writesDisabled: offlineWritesDisabled,
	clearCache: clearOfflineCache,
} = usePostboxOfflineCache();

const clearingCache = ref(false);

function onOfflineCacheChange(event: Event) {
	setOfflineCacheEnabled((event.target as HTMLInputElement).checked);
}

async function onClearOfflineCache() {
	clearingCache.value = true;
	try {
		await clearOfflineCache();
	} finally {
		clearingCache.value = false;
	}
}
</script>

<template>
	<!-- On this device: offline read cache (device-local, never synced). -->
	<section class="card !p-0 mb-6">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">{{ t('components.postbox.postboxOfflineSettings.heading') }}</h2>
		</header>
		<div class="px-5 py-4 flex items-center justify-between gap-4">
			<div class="min-w-0">
				<label for="postbox-offline-cache" class="font-medium text-sm block">
					{{ t('components.postbox.postboxOfflineSettings.store.label') }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.postbox.postboxOfflineSettings.store.hint') }}
					{{
						isDesktop
							? t('components.postbox.postboxOfflineSettings.store.defaultDesktop')
							: t('components.postbox.postboxOfflineSettings.store.defaultBrowser')
					}}
				</p>
				<p v-if="offlineWritesDisabled" class="text-xs text-warning mt-1">
					{{ t('components.postbox.postboxOfflineSettings.writesDisabled') }}
				</p>
			</div>
			<input
				id="postbox-offline-cache"
				type="checkbox"
				class="shrink-0 h-4 w-4"
				:checked="offlineCacheEnabled"
				@change="onOfflineCacheChange"
			/>
		</div>
		<div
			v-if="shellStatus"
			class="px-5 py-4 border-t border-border-subtle"
			data-testid="offline-shell-status"
		>
			<p class="font-medium text-sm">
				{{ t('components.postbox.postboxOfflineSettings.shell.label') }}
			</p>
			<p class="text-xs text-text-tertiary mt-0.5">{{ t(shellStatus.key) }}</p>
		</div>
		<div class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle">
			<div class="min-w-0">
				<p class="font-medium text-sm">
					{{ t('components.postbox.postboxOfflineSettings.clear.label') }}
				</p>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.postbox.postboxOfflineSettings.clear.hint') }}
				</p>
			</div>
			<UiButton variant="secondary" size="sm" :loading="clearingCache" @click="onClearOfflineCache">
				{{ t('components.postbox.postboxOfflineSettings.clear.action') }}
			</UiButton>
		</div>
	</section>
</template>
