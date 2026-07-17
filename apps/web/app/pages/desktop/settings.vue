<script setup lang="ts">
/**
 * Desktop settings surface — global (device-wide) + per-workspace.
 *
 * Lives OUTSIDE /dashboard on purpose: the native menu's Settings item must
 * work with no active workspace and no session (the dashboard tree requires
 * both), so like /desktop/welcome this page renders standalone and is
 * allowlisted in middleware/desktop-workspace.global.ts. Global settings
 * persist to settings.json via useDesktopAppSettings; workspace cards edit
 * device-local prefs (accent, mute) and link into the Convex-backed
 * /dashboard/settings hub for everything server-side.
 */
useHead({ title: "Settings — Owlat" });
definePageMeta({ layout: false });

import type { ThemeOption } from "~/composables/useAppTheme";
import { WORKSPACE_ACCENT_OPTIONS } from "~/lib/desktop/workspaceTypes";

const { isDesktop } = useDesktopContext();
const { settings, isReady, setGlobal, workspaceLocal, setWorkspaceLocal } = useDesktopAppSettings();
const {
	isDesktop: autostartAvailable,
	autostartEnabled,
	isReady: autostartReady,
	setAutostart,
} = useDesktopSettings();
const { workspaces, activeId, switchTo, removeWorkspace, setWorkspaceAccent } =
	useDesktopWorkspaces();
const { themePreference, setTheme } = useAppTheme();

const themeOptions: { value: ThemeOption; label: string; icon: string }[] = [
	{ value: "light", label: "Light", icon: "lucide:sun" },
	{ value: "dark", label: "Dark", icon: "lucide:moon" },
	{ value: "system", label: "System", icon: "lucide:monitor" },
];

// Back target mirrors how the user got here: into the app when a workspace is
// active, otherwise to the welcome flow.
const backTarget = computed(() => (activeId.value ? "/dashboard" : "/desktop/welcome"));

const appVersion = ref("");
onMounted(async () => {
	if (!isDesktop.value) return;
	try {
		const { getVersion } = await import("@tauri-apps/api/app");
		appVersion.value = await getVersion();
	} catch {
		// Tauri not available.
	}
});

async function onAutostartToggle(e: Event) {
	await setAutostart((e.target as HTMLInputElement).checked);
}

function checked(e: Event): boolean {
	return (e.target as HTMLInputElement).checked;
}

// Manual update check rides the same window event the auto-updater listens
// for; the result arrives as a native notification.
const updateCheckRequested = ref(false);
function checkForUpdatesNow() {
	window.dispatchEvent(new Event("owlat:check-updates"));
	updateCheckRequested.value = true;
}

function onStartupWorkspaceChange(e: Event) {
	const value = (e.target as HTMLSelectElement).value;
	setGlobal("startupWorkspaceId", value || null);
}

/** Server-side settings live in the dashboard — switch there (reloads the
 * webview when the target isn't the active workspace). */
function openWorkspaceSettings(id: string) {
	if (id === activeId.value) {
		void navigateTo("/dashboard/settings");
		return;
	}
	void switchTo(id, { destination: "/dashboard/settings" });
}

const workspaceToRemove = ref<{ id: string; label: string } | null>(null);
const isRemoving = ref(false);
async function confirmRemoveWorkspace() {
	if (!workspaceToRemove.value) return;
	isRemoving.value = true;
	// Navigates away (webview reload) on completion — no local cleanup needed.
	await removeWorkspace(workspaceToRemove.value.id);
}

// Which OS the user is on, so we can show the right "set as default mail app"
// steps. macOS/Windows/Linux all require a user action in the OS settings —
// there is no reliable API to register the default mail handler programmatically.
const defaultAppOs = computed<"macos" | "windows" | "linux" | "other">(() => {
	if (import.meta.server) return "other";
	const ua = navigator.userAgent;
	if (/Mac/i.test(ua)) return "macos";
	if (/Win/i.test(ua)) return "windows";
	if (/Linux|X11/i.test(ua)) return "linux";
	return "other";
});
</script>

<template>
	<div
		class="min-h-screen bg-bg-deep text-text-primary"
		:style="isDesktop ? { paddingTop: 'var(--titlebar-h, 44px)' } : undefined"
	>
		<!-- Native window titlebar (this page renders inside the Tauri webview). -->
		<DesktopTitlebar />

		<div class="mx-auto w-full max-w-2xl px-6 py-10">
			<div
				v-if="!isDesktop"
				class="rounded-2xl border border-border-default bg-bg-surface p-8 text-sm text-text-secondary"
			>
				These settings are only available in the Owlat desktop app.
			</div>

			<template v-else>
				<NuxtLink
					:to="backTarget"
					class="mb-4 inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary"
				>
					<Icon name="lucide:arrow-left" class="size-3.5" /> Back
				</NuxtLink>

				<h1 class="text-2xl font-semibold mb-1">Settings</h1>
				<p class="text-sm text-text-secondary mb-8">
					Global settings apply to the Owlat app on this device, across every workspace.
				</p>

				<!-- ============ GLOBAL ============ -->
				<h2 class="text-xs font-medium uppercase tracking-wide text-text-secondary mb-2">Global</h2>
				<div
					class="rounded-lg border border-border-default bg-bg-surface divide-y divide-border-subtle mb-8"
				>
					<!-- Appearance -->
					<div class="p-4">
						<span class="block text-sm font-medium">Appearance</span>
						<span class="block text-xs text-text-secondary mb-3">
							Theme for the whole app on this device.
						</span>
						<div class="flex gap-2">
							<button
								v-for="option in themeOptions"
								:key="option.value"
								type="button"
								class="flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
								:class="
									themePreference === option.value
										? 'border-brand bg-brand-subtle font-medium'
										: 'border-border-default hover:border-border-strong'
								"
								:aria-pressed="themePreference === option.value"
								@click="setTheme(option.value)"
							>
								<Icon :name="option.icon" class="size-4" />
								{{ option.label }}
							</button>
						</div>
					</div>

					<!-- Launch at login -->
					<label class="flex items-center justify-between p-4">
						<span>
							<span class="block text-sm font-medium">Launch at login</span>
							<span class="block text-xs text-text-secondary">
								Start Owlat automatically when you log in.
							</span>
						</span>
						<input
							type="checkbox"
							:checked="autostartEnabled"
							:disabled="!autostartReady || !autostartAvailable"
							class="h-5 w-5"
							@change="onAutostartToggle"
						/>
					</label>

					<!-- Startup workspace -->
					<label class="flex items-center justify-between gap-4 p-4">
						<span>
							<span class="block text-sm font-medium">Open at startup</span>
							<span class="block text-xs text-text-secondary">
								Which workspace Owlat opens when it launches.
							</span>
						</span>
						<select
							:value="settings.global.startupWorkspaceId ?? ''"
							:disabled="!isReady || workspaces.length === 0"
							class="max-w-[14rem] rounded-lg border border-border-default bg-bg-deep px-2 py-1.5 text-sm"
							@change="onStartupWorkspaceChange"
						>
							<option value="">Last active workspace</option>
							<option v-for="ws in workspaces" :key="ws.id" :value="ws.id">
								{{ ws.label }}
							</option>
						</select>
					</label>

					<!-- Notifications -->
					<label class="flex items-center justify-between p-4">
						<span>
							<span class="block text-sm font-medium">Desktop notifications</span>
							<span class="block text-xs text-text-secondary">
								Show native notifications for new mail and activity.
							</span>
						</span>
						<input
							type="checkbox"
							:checked="settings.global.notificationsEnabled"
							:disabled="!isReady"
							class="h-5 w-5"
							@change="setGlobal('notificationsEnabled', checked($event))"
						/>
					</label>
					<label class="flex items-center justify-between p-4">
						<span>
							<span class="block text-sm font-medium">Unread badge</span>
							<span class="block text-xs text-text-secondary">
								Show the unread count on the app icon.
							</span>
						</span>
						<input
							type="checkbox"
							:checked="settings.global.showUnreadBadge"
							:disabled="!isReady"
							class="h-5 w-5"
							@change="setGlobal('showUnreadBadge', checked($event))"
						/>
					</label>

					<!-- Updates -->
					<div class="p-4">
						<div class="flex items-center justify-between">
							<span>
								<span class="block text-sm font-medium">Updates</span>
								<span class="block text-xs text-text-secondary">
									{{ appVersion ? `Owlat ${appVersion}.` : "" }}
									Check for new versions when the app starts.
								</span>
							</span>
							<input
								type="checkbox"
								:checked="settings.global.autoCheckUpdates"
								:disabled="!isReady"
								class="h-5 w-5"
								@change="setGlobal('autoCheckUpdates', checked($event))"
							/>
						</div>
						<button
							type="button"
							class="mt-3 rounded-lg border border-border-default px-3 py-1.5 text-sm hover:border-border-strong"
							@click="checkForUpdatesNow"
						>
							Check for updates now
						</button>
						<p v-if="updateCheckRequested" class="mt-2 text-xs text-text-secondary">
							Checking — you'll get a notification with the result.
						</p>
					</div>

					<!-- Default email app -->
					<div class="p-4">
						<span class="block text-sm font-medium">Default email app</span>
						<span class="block text-xs text-text-secondary mb-2">
							Make Owlat open when you click a <code>mailto:</code> link. Your operating system
							controls the default mail app, so this is a one-time step you take there:
						</span>
						<ul class="list-disc pl-5 text-xs text-text-secondary space-y-1">
							<li v-if="defaultAppOs === 'macos'">
								Open <strong>Mail &gt; Settings &gt; General</strong> and set
								<strong>Default email reader</strong> to Owlat.
							</li>
							<li v-else-if="defaultAppOs === 'windows'">
								Open <strong>Settings &gt; Apps &gt; Default apps</strong>, search for Owlat, and
								set it as the handler for <code>mailto</code>.
							</li>
							<li v-else-if="defaultAppOs === 'linux'">
								Set Owlat as your <code>x-scheme-handler/mailto</code> default (for example with
								<code>xdg-mime default owlat.desktop x-scheme-handler/mailto</code>, or via your
								desktop environment's default-applications settings).
							</li>
							<li v-else>
								Set Owlat as the <code>mailto:</code> handler in your operating system's
								default-apps settings.
							</li>
						</ul>
					</div>
				</div>

				<!-- ============ WORKSPACES ============ -->
				<h2 class="text-xs font-medium uppercase tracking-wide text-text-secondary mb-2">
					Workspaces
				</h2>

				<div
					v-if="workspaces.length === 0"
					class="rounded-lg border border-border-default bg-bg-surface p-6 text-center"
				>
					<p class="text-sm text-text-secondary mb-4">
						No workspaces connected yet. Workspace settings — members, delivery, API keys and more —
						become available once you connect to an Owlat server.
					</p>
					<NuxtLink
						to="/desktop/welcome"
						class="inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white"
					>
						Connect a workspace
					</NuxtLink>
				</div>

				<ul v-else class="space-y-3">
					<li
						v-for="ws in workspaces"
						:key="ws.id"
						class="rounded-lg border border-border-default bg-bg-surface p-4"
					>
						<div class="flex items-start justify-between gap-4">
							<div class="min-w-0">
								<div class="flex items-center gap-2">
									<span
										class="size-2.5 shrink-0 rounded-full"
										:style="{ backgroundColor: ws.accentColor }"
									/>
									<span class="truncate text-sm font-medium">{{ ws.label }}</span>
									<span
										v-if="ws.id === activeId"
										class="rounded-full bg-brand-subtle px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand"
									>
										Active
									</span>
								</div>
								<span class="mt-0.5 block truncate text-xs text-text-secondary">
									{{ ws.siteUrl }}
								</span>
							</div>
							<div class="flex shrink-0 items-center gap-3">
								<button
									type="button"
									class="text-xs text-brand hover:text-brand-hover"
									@click="openWorkspaceSettings(ws.id)"
								>
									Workspace settings
								</button>
								<button
									type="button"
									class="text-xs text-text-secondary hover:text-red-400"
									@click="workspaceToRemove = { id: ws.id, label: ws.label }"
								>
									Remove
								</button>
							</div>
						</div>

						<div class="mt-3 flex items-center justify-between border-t border-border-subtle pt-3">
							<!-- Identity accent -->
							<div class="flex items-center gap-1.5">
								<span class="mr-1 text-xs text-text-secondary">Accent</span>
								<button
									v-for="option in WORKSPACE_ACCENT_OPTIONS"
									:key="option.value"
									type="button"
									class="size-5 rounded-full border-2 transition-transform hover:scale-110"
									:class="
										ws.accentColor === option.value ? 'border-text-primary' : 'border-transparent'
									"
									:style="{ backgroundColor: option.value }"
									:title="option.label"
									:aria-label="`${option.label} accent`"
									:aria-pressed="ws.accentColor === option.value"
									@click="setWorkspaceAccent(ws.id, option.value)"
								/>
							</div>

							<!-- Device-local mute -->
							<label class="flex items-center gap-2 text-xs text-text-secondary">
								Mute notifications
								<input
									type="checkbox"
									:checked="workspaceLocal(ws.id).muteNotifications"
									:disabled="!isReady"
									class="h-4 w-4"
									@change="setWorkspaceLocal(ws.id, 'muteNotifications', checked($event))"
								/>
							</label>
						</div>
					</li>
				</ul>

				<UiConfirmationDialog
					:open="!!workspaceToRemove"
					variant="danger"
					title="Remove workspace?"
					:description="`Remove ${workspaceToRemove?.label ?? 'this workspace'} from this device? You'll be signed out here; the workspace itself and your account are untouched.`"
					confirm-text="Remove workspace"
					:is-loading="isRemoving"
					@update:open="(v: boolean) => !v && (workspaceToRemove = null)"
					@confirm="confirmRemoveWorkspace"
				/>
			</template>
		</div>
	</div>
</template>
