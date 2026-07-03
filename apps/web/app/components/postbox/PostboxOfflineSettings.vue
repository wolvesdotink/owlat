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
const { isDesktop } = useDesktopContext();

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
			<h2 class="font-semibold">On this device</h2>
		</header>
		<div class="px-5 py-4 flex items-center justify-between gap-4">
			<div class="min-w-0">
				<label for="postbox-offline-cache" class="font-medium text-sm block">
					Store recent mail on this device
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					Keeps your inbox list and recently-read messages readable instantly and
					without a connection. Only sanitized mail is stored, unencrypted, in this
					browser's local database — leave it off on shared computers.
					{{ isDesktop ? 'On by default in the desktop app.' : 'Off by default in the browser.' }}
				</p>
				<p v-if="offlineWritesDisabled" class="text-xs text-warning mt-1">
					Local storage is full or unavailable — new mail isn't being cached on this
					device. Clearing the cache may help.
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
			class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
		>
			<div class="min-w-0">
				<p class="font-medium text-sm">Clear local cache</p>
				<p class="text-xs text-text-tertiary mt-0.5">
					Wipe every thread row and message body cached on this device.
				</p>
			</div>
			<UiButton
				variant="secondary"
				size="sm"
				:loading="clearingCache"
				@click="onClearOfflineCache"
			>
				Clear
			</UiButton>
		</div>
	</section>
</template>
