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

// Which OS the user is on, so we can show the right "set as default mail app"
// steps. macOS/Windows/Linux all require a user action in the OS settings —
// there is no reliable API to register the default mail handler programmatically.
const defaultAppOs = computed<'macos' | 'windows' | 'linux' | 'other'>(() => {
	if (import.meta.server) return 'other';
	const ua = navigator.userAgent;
	if (/Mac/i.test(ua)) return 'macos';
	if (/Win/i.test(ua)) return 'windows';
	if (/Linux|X11/i.test(ua)) return 'linux';
	return 'other';
});
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

			<div class="p-4">
				<span class="block text-sm font-medium text-text-primary">Default email app</span>
				<span class="block text-xs text-text-secondary mb-2">
					Make Owlat open when you click a <code>mailto:</code> link. Your operating
					system controls the default mail app, so this is a one-time step you take there:
				</span>
				<ul class="list-disc pl-5 text-xs text-text-secondary space-y-1">
					<li v-if="defaultAppOs === 'macos'">
						Open <strong>Mail &gt; Settings &gt; General</strong> and set
						<strong>Default email reader</strong> to Owlat.
					</li>
					<li v-else-if="defaultAppOs === 'windows'">
						Open <strong>Settings &gt; Apps &gt; Default apps</strong>, search for
						Owlat, and set it as the handler for <code>mailto</code>.
					</li>
					<li v-else-if="defaultAppOs === 'linux'">
						Set Owlat as your <code>x-scheme-handler/mailto</code> default (for example
						with <code>xdg-mime default owlat.desktop x-scheme-handler/mailto</code>, or
						via your desktop environment's default-applications settings).
					</li>
					<li v-else>
						Set Owlat as the <code>mailto:</code> handler in your operating system's
						default-apps settings.
					</li>
				</ul>
			</div>
		</div>
	</div>
</template>
