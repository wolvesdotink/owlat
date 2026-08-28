<script setup lang="ts">
/**
 * "This device" — everything that is stored on this machine rather than on the
 * server, in the Preferences tree with everything else.
 *
 * This was `/desktop/settings`: a 441-line page outside `/dashboard` with its
 * own chrome, `layout: false`, its own titlebar and its own back link, reachable
 * only from the native menu — and it duplicated the appearance and notification
 * controls that already lived in Preferences. Now it is a normal Preferences
 * page, the theme picker is gone (there is one, on General → Appearance), and
 * `/desktop/settings` is a redirect.
 *
 * Every section self-hides (the pattern `PostboxOfflineSettings` already used):
 * a browser sees only the offline cache, the desktop app sees the lot, and the
 * page itself is gated out of the registry when neither applies. The section
 * `id`s are the settings registry's control anchors, so a palette deep link
 * ("notify me about", "launch at login") lands on the right card.
 */
import { WORKSPACE_ACCENT_OPTIONS } from '~/lib/desktop/workspaceTypes';

const { t } = useI18n();

useHead({ title: () => t('desktop.settings.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
});

const { isEnabled } = useFeatureFlag();
const { isDesktop, platform } = useDesktopContext();
const hasMail = computed(() => isEnabled('postbox') || isEnabled('mail.external'));

const { settings, isReady, setGlobal, workspaceLocal, setWorkspaceLocal } = useDesktopAppSettings();
const { autostartEnabled, isReady: autostartReady, setAutostart } = useDesktopSettings();
const { workspaces, activeId, switchTo, removeWorkspace, setWorkspaceAccent } =
	useDesktopWorkspaces();

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

function checked(event: Event): boolean {
	return (event.target as HTMLInputElement).checked;
}

async function onAutostartToggle(event: Event) {
	await setAutostart(checked(event));
}

function onStartupWorkspaceChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value;
	setGlobal('startupWorkspaceId', value || null);
}

// Manual update check rides the same window event the auto-updater listens for;
// the result arrives as a native notification.
const updateCheckRequested = ref(false);
function checkForUpdatesNow() {
	window.dispatchEvent(new Event('owlat:check-updates'));
	updateCheckRequested.value = true;
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
</script>

<template>
	<div>
		<p class="mb-6 text-text-secondary">
			{{ t('dashboard.preferences.device.intro') }}
		</p>

		<!-- Offline read cache: device-local, never synced. Any browser. -->
		<div v-if="hasMail" id="offline" class="scroll-mt-6">
			<PostboxOfflineSettings />
		</div>

		<template v-if="isDesktop">
			<section id="notifications" class="card !p-0 mb-6 scroll-mt-6 overflow-hidden">
				<header class="px-5 py-3 border-b border-border-subtle">
					<h2 class="font-semibold">{{ t('desktop.settings.notifications.title') }}</h2>
				</header>
				<label class="flex items-center justify-between gap-4 px-5 py-4">
					<span>
						<span class="block text-sm font-medium">{{
							t('desktop.settings.notifications.title')
						}}</span>
						<span class="block text-xs text-text-tertiary">{{
							t('desktop.settings.notifications.description')
						}}</span>
					</span>
					<input
						type="checkbox"
						class="h-5 w-5 shrink-0"
						:checked="settings.global.notificationsEnabled"
						:disabled="!isReady"
						@change="setGlobal('notificationsEnabled', checked($event))"
					/>
				</label>
				<label
					class="flex items-center justify-between gap-4 border-t border-border-subtle px-5 py-4"
				>
					<span>
						<span class="block text-sm font-medium">{{
							t('desktop.settings.unreadBadge.title')
						}}</span>
						<span class="block text-xs text-text-tertiary">{{
							t('desktop.settings.unreadBadge.description')
						}}</span>
					</span>
					<input
						type="checkbox"
						class="h-5 w-5 shrink-0"
						:checked="settings.global.showUnreadBadge"
						:disabled="!isReady"
						@change="setGlobal('showUnreadBadge', checked($event))"
					/>
				</label>
			</section>

			<!-- Which mail is worth a notification, quiet hours, preview hiding. -->
			<PostboxNotificationSettings v-if="hasMail" />

			<section id="startup" class="card !p-0 mb-6 scroll-mt-6 overflow-hidden">
				<header class="px-5 py-3 border-b border-border-subtle">
					<h2 class="font-semibold">{{ t('desktop.settings.globalHeading') }}</h2>
				</header>
				<label class="flex items-center justify-between gap-4 px-5 py-4">
					<span>
						<span class="block text-sm font-medium">{{
							t('desktop.settings.autostart.title')
						}}</span>
						<span class="block text-xs text-text-tertiary">{{
							t('desktop.settings.autostart.description')
						}}</span>
					</span>
					<input
						type="checkbox"
						class="h-5 w-5 shrink-0"
						:checked="autostartEnabled"
						:disabled="!autostartReady"
						@change="onAutostartToggle"
					/>
				</label>
				<label
					class="flex items-center justify-between gap-4 border-t border-border-subtle px-5 py-4"
				>
					<span>
						<span class="block text-sm font-medium">{{ t('desktop.settings.startup.title') }}</span>
						<span class="block text-xs text-text-tertiary">{{
							t('desktop.settings.startup.description')
						}}</span>
					</span>
					<select
						class="input input-sm max-w-[14rem] shrink-0 text-sm"
						:value="settings.global.startupWorkspaceId ?? ''"
						:disabled="!isReady || workspaces.length === 0"
						@change="onStartupWorkspaceChange"
					>
						<option value="">{{ t('desktop.settings.startup.lastActive') }}</option>
						<option v-for="ws in workspaces" :key="ws.id" :value="ws.id">{{ ws.label }}</option>
					</select>
				</label>
			</section>

			<section id="updates" class="card mb-6 scroll-mt-6">
				<div class="flex items-center justify-between gap-4">
					<span>
						<span class="block text-sm font-medium">{{ t('desktop.settings.updates.title') }}</span>
						<span class="block text-xs text-text-tertiary">
							{{ appVersion ? t('desktop.settings.updates.version', { version: appVersion }) : '' }}
							{{ t('desktop.settings.updates.description') }}
						</span>
					</span>
					<input
						type="checkbox"
						class="h-5 w-5 shrink-0 accent-brand"
						:checked="settings.global.autoCheckUpdates"
						:disabled="!isReady"
						@change="setGlobal('autoCheckUpdates', checked($event))"
					/>
				</div>
				<UiButton variant="outline" size="sm" class="mt-3" @click="checkForUpdatesNow">
					{{ t('desktop.settings.updates.checkNow') }}
				</UiButton>
				<p v-if="updateCheckRequested" class="mt-2 text-xs text-text-tertiary">
					{{ t('desktop.settings.updates.checking') }}
				</p>
			</section>

			<!-- macOS, Windows and Linux all require a user action in the OS
			     settings: there is no reliable API to register the default mail
			     handler programmatically, so we say where to look. -->
			<section id="default-app" class="card mb-6 scroll-mt-6">
				<h2 class="text-sm font-medium">{{ t('desktop.settings.defaultApp.title') }}</h2>
				<I18nT
					keypath="desktop.settings.defaultApp.description"
					tag="p"
					class="mt-1 mb-2 text-xs text-text-tertiary"
					scope="global"
				>
					<template #mailto><code>mailto:</code></template>
				</I18nT>
				<ul class="list-disc space-y-1 pl-5 text-xs text-text-tertiary">
					<I18nT
						v-if="platform === 'mac'"
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
						v-else-if="platform === 'windows'"
						keypath="desktop.settings.defaultApp.windows"
						tag="li"
						scope="global"
					>
						<template #path
							><strong>{{ t('desktop.settings.defaultApp.windowsPath') }}</strong></template
						>
						<template #scheme><code>mailto</code></template>
					</I18nT>
					<I18nT v-else keypath="desktop.settings.defaultApp.linux" tag="li" scope="global">
						<template #handler><code>x-scheme-handler/mailto</code></template>
						<template #command
							><code>xdg-mime default owlat.desktop x-scheme-handler/mailto</code></template
						>
					</I18nT>
				</ul>
			</section>

			<section id="workspaces" class="scroll-mt-6">
				<h2 class="mb-2 text-xs font-medium uppercase tracking-wider text-text-tertiary">
					{{ t('desktop.settings.workspaces.heading') }}
				</h2>

				<div v-if="workspaces.length === 0" class="card text-center">
					<p class="mb-4 text-sm text-text-secondary">
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
									class="h-4 w-4"
									:checked="workspaceLocal(ws.id).muteNotifications"
									:disabled="!isReady"
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
			</section>
		</template>

		<p v-else-if="!hasMail" class="card p-8 text-center text-sm text-text-secondary">
			{{ t('dashboard.preferences.device.nothingHere') }}
		</p>
	</div>
</template>
