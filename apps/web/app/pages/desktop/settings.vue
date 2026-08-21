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
 * /dashboard/admin hub for everything server-side.
 */
const { t } = useI18n();

useHead({ title: () => t('desktop.settings.pageTitle') });
definePageMeta({ layout: false });

import type { ThemeOption } from '~/composables/useAppTheme';
import { WORKSPACE_ACCENT_OPTIONS } from '~/lib/desktop/workspaceTypes';

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
	{ value: 'light', label: 'desktop.settings.theme.light', icon: 'lucide:sun' },
	{ value: 'dark', label: 'desktop.settings.theme.dark', icon: 'lucide:moon' },
	{ value: 'system', label: 'desktop.settings.theme.system', icon: 'lucide:monitor' },
];

// Back target mirrors how the user got here: into the app when a workspace is
// active, otherwise to the welcome flow.
const backTarget = computed(() => (activeId.value ? '/dashboard' : '/desktop/welcome'));

const appVersion = ref('');
onMounted(async () => {
	if (!isDesktop.value) return;
	try {
		const { getVersion } = await import('@tauri-apps/api/app');
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
	window.dispatchEvent(new Event('owlat:check-updates'));
	updateCheckRequested.value = true;
}

function onStartupWorkspaceChange(e: Event) {
	const value = (e.target as HTMLSelectElement).value;
	setGlobal('startupWorkspaceId', value || null);
}

/** Server-side settings live in the dashboard — switch there (reloads the
 * webview when the target isn't the active workspace). */
function openWorkspaceSettings(id: string) {
	if (id === activeId.value) {
		void navigateTo('/dashboard/admin');
		return;
	}
	void switchTo(id, { destination: '/dashboard/admin' });
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
	<div
		class="min-h-screen bg-bg-deep text-text-primary"
		:style="isDesktop ? { paddingTop: 'var(--titlebar-h, 44px)' } : undefined"
	>
		<!-- Native window titlebar (this page renders inside the Tauri webview). -->
		<DesktopTitlebar />

		<div class="mx-auto w-full max-w-2xl px-6 py-10">
			<div v-if="!isDesktop" class="card p-8 text-sm text-text-secondary">
				{{ t('desktop.settings.desktopOnly') }}
			</div>

			<template v-else>
				<NuxtLink
					:to="backTarget"
					class="mb-4 inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary"
				>
					<Icon name="lucide:arrow-left" class="size-3.5" /> {{ t('common.back') }}
				</NuxtLink>

				<h1 class="text-2xl font-medium tracking-[-0.02em] mb-1">{{ t('common.settings') }}</h1>
				<p class="text-sm text-text-secondary mb-8">
					{{ t('desktop.settings.subtitle') }}
				</p>

				<!-- ============ GLOBAL ============ -->
				<h2 class="text-xs font-medium uppercase tracking-wide text-text-secondary mb-2">
					{{ t('desktop.settings.globalHeading') }}
				</h2>
				<div class="card p-0 divide-y divide-border-subtle mb-8 overflow-hidden">
					<!-- Appearance -->
					<div class="p-4">
						<span class="block text-sm font-medium">{{
							t('desktop.settings.appearance.title')
						}}</span>
						<span class="block text-xs text-text-secondary mb-3">
							{{ t('desktop.settings.appearance.description') }}
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
								{{ t(option.label) }}
							</button>
						</div>
					</div>

					<!-- Launch at login -->
					<label class="flex items-center justify-between p-4">
						<span>
							<span class="block text-sm font-medium">{{
								t('desktop.settings.autostart.title')
							}}</span>
							<span class="block text-xs text-text-secondary">
								{{ t('desktop.settings.autostart.description') }}
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
							<span class="block text-sm font-medium">{{
								t('desktop.settings.startup.title')
							}}</span>
							<span class="block text-xs text-text-secondary">
								{{ t('desktop.settings.startup.description') }}
							</span>
						</span>
						<select
							:value="settings.global.startupWorkspaceId ?? ''"
							:disabled="!isReady || workspaces.length === 0"
							class="input input-sm max-w-[14rem] text-sm"
							@change="onStartupWorkspaceChange"
						>
							<option value="">{{ t('desktop.settings.startup.lastActive') }}</option>
							<option v-for="ws in workspaces" :key="ws.id" :value="ws.id">
								{{ ws.label }}
							</option>
						</select>
					</label>

					<!-- Notifications -->
					<label class="flex items-center justify-between p-4">
						<span>
							<span class="block text-sm font-medium">{{
								t('desktop.settings.notifications.title')
							}}</span>
							<span class="block text-xs text-text-secondary">
								{{ t('desktop.settings.notifications.description') }}
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
							<span class="block text-sm font-medium">{{
								t('desktop.settings.unreadBadge.title')
							}}</span>
							<span class="block text-xs text-text-secondary">
								{{ t('desktop.settings.unreadBadge.description') }}
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
								<span class="block text-sm font-medium">{{
									t('desktop.settings.updates.title')
								}}</span>
								<span class="block text-xs text-text-secondary">
									{{
										appVersion ? t('desktop.settings.updates.version', { version: appVersion }) : ''
									}}
									{{ t('desktop.settings.updates.description') }}
								</span>
							</span>
							<input
								type="checkbox"
								:checked="settings.global.autoCheckUpdates"
								:disabled="!isReady"
								class="h-5 w-5 accent-brand"
								@change="setGlobal('autoCheckUpdates', checked($event))"
							/>
						</div>
						<UiButton variant="outline" size="sm" class="mt-3" @click="checkForUpdatesNow">
							{{ t('desktop.settings.updates.checkNow') }}
						</UiButton>
						<p v-if="updateCheckRequested" class="mt-2 text-xs text-text-secondary">
							{{ t('desktop.settings.updates.checking') }}
						</p>
					</div>

					<!-- Default email app -->
					<div class="p-4">
						<span class="block text-sm font-medium">{{
							t('desktop.settings.defaultApp.title')
						}}</span>
						<I18nT
							keypath="desktop.settings.defaultApp.description"
							tag="span"
							class="block text-xs text-text-secondary mb-2"
							scope="global"
						>
							<template #mailto><code>mailto:</code></template>
						</I18nT>
						<ul class="list-disc pl-5 text-xs text-text-secondary space-y-1">
							<I18nT
								v-if="defaultAppOs === 'macos'"
								keypath="desktop.settings.defaultApp.macos"
								tag="li"
								scope="global"
							>
								<template #path
									><strong>{{ t('desktop.settings.defaultApp.macosPath') }}</strong></template
								>
								<template #setting
									><strong>{{ t('desktop.settings.defaultApp.macosSetting') }}</strong></template
								>
							</I18nT>
							<I18nT
								v-else-if="defaultAppOs === 'windows'"
								keypath="desktop.settings.defaultApp.windows"
								tag="li"
								scope="global"
							>
								<template #path
									><strong>{{ t('desktop.settings.defaultApp.windowsPath') }}</strong></template
								>
								<template #scheme><code>mailto</code></template>
							</I18nT>
							<I18nT
								v-else-if="defaultAppOs === 'linux'"
								keypath="desktop.settings.defaultApp.linux"
								tag="li"
								scope="global"
							>
								<template #handler><code>x-scheme-handler/mailto</code></template>
								<template #command
									><code>xdg-mime default owlat.desktop x-scheme-handler/mailto</code></template
								>
							</I18nT>
							<I18nT v-else keypath="desktop.settings.defaultApp.other" tag="li" scope="global">
								<template #scheme><code>mailto:</code></template>
							</I18nT>
						</ul>
					</div>
				</div>

				<!-- ============ WORKSPACES ============ -->
				<h2 class="text-xs font-medium uppercase tracking-wide text-text-secondary mb-2">
					{{ t('desktop.settings.workspaces.heading') }}
				</h2>

				<div v-if="workspaces.length === 0" class="card text-center">
					<p class="text-sm text-text-secondary mb-4">
						{{ t('desktop.settings.workspaces.empty') }}
					</p>
					<UiButton to="/desktop/welcome" size="sm">
						{{ t('desktop.settings.workspaces.connect') }}
					</UiButton>
				</div>

				<ul v-else class="space-y-3">
					<li v-for="ws in workspaces" :key="ws.id" class="card p-4">
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
										class="rounded-full bg-brand-subtle px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-brand"
									>
										{{ t('common.active') }}
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
									{{ t('desktop.settings.workspaces.settings') }}
								</button>
								<button
									type="button"
									class="text-xs text-text-secondary hover:text-error"
									@click="workspaceToRemove = { id: ws.id, label: ws.label }"
								>
									{{ t('common.remove') }}
								</button>
							</div>
						</div>

						<div class="mt-3 flex items-center justify-between border-t border-border-subtle pt-3">
							<!-- Identity accent -->
							<div class="flex items-center gap-1.5">
								<span class="mr-1 text-xs text-text-secondary">{{
									t('desktop.settings.workspaces.accent')
								}}</span>
								<button
									v-for="option in WORKSPACE_ACCENT_OPTIONS"
									:key="option.value"
									type="button"
									class="size-5 rounded-full border-2 transition-transform hover:scale-110"
									:class="
										ws.accentColor === option.value ? 'border-text-primary' : 'border-transparent'
									"
									:style="{ backgroundColor: option.value }"
									:title="t(option.label)"
									:aria-label="
										t('desktop.settings.workspaces.accentOption', { accent: t(option.label) })
									"
									:aria-pressed="ws.accentColor === option.value"
									@click="setWorkspaceAccent(ws.id, option.value)"
								/>
							</div>

							<!-- Device-local mute -->
							<label class="flex items-center gap-2 text-xs text-text-secondary">
								{{ t('desktop.settings.workspaces.mute') }}
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
					:title="t('desktop.settings.workspaces.removeDialog.title')"
					:description="
						t('desktop.settings.workspaces.removeDialog.description', {
							workspace:
								workspaceToRemove?.label ??
								t('desktop.settings.workspaces.removeDialog.fallbackName'),
						})
					"
					:confirm-text="t('desktop.settings.workspaces.removeDialog.confirm')"
					:is-loading="isRemoving"
					@update:open="(v: boolean) => !v && (workspaceToRemove = null)"
					@confirm="confirmRemoveWorkspace"
				/>
			</template>
		</div>
	</div>
</template>
