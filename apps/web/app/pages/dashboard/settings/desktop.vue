<script setup lang="ts">
useHead({ title: 'Desktop — Settings — Owlat' });
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { isDesktop, autostartEnabled, isReady, setAutostart } = useDesktopSettings();

async function onToggle(e: Event) {
	await setAutostart((e.target as HTMLInputElement).checked);
}
</script>

<template>
	<div class="max-w-2xl mx-auto px-4 py-8">
		<h1 class="text-2xl font-semibold text-text-primary mb-1">Desktop</h1>
		<p class="text-sm text-text-secondary mb-6">
			Settings for the Owlat desktop app on this device.
		</p>

		<div v-if="!isDesktop" class="rounded-lg border border-border-subtle p-4 text-sm text-text-secondary">
			These settings are only available in the desktop app.
		</div>

		<div v-else class="rounded-lg border border-border-subtle divide-y divide-border-subtle">
			<label class="flex items-center justify-between p-4">
				<span>
					<span class="block text-sm font-medium text-text-primary">Launch at login</span>
					<span class="block text-xs text-text-secondary">
						Start Owlat automatically (minimized to the tray) when you log in.
					</span>
				</span>
				<input
					type="checkbox"
					:checked="autostartEnabled"
					:disabled="!isReady"
					class="h-5 w-5"
					@change="onToggle"
				/>
			</label>
		</div>
	</div>
</template>
