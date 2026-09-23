<script setup lang="ts">
/**
 * Desktop landing flow. Shown when running in the desktop app with no active
 * workspace (gated by middleware/desktop-workspace.global.ts), and reachable
 * to add/switch workspaces.
 *
 * One screen. Most people who install the desktop app were invited by their
 * company and need to connect to a server that already exists, so the main
 * card is "Connect to your workspace" with the server address field right in
 * it. Setting up a new server is a one-time admin job and sits below as the
 * secondary option.
 *
 * It is ALSO where a signed-out desktop lands: the packaged app has no in-app
 * login form, so middleware/auth.ts bounces an expired or never-completed
 * session here. That arrival must not look like a first run — the connected
 * servers are listed with a way to reconnect or remove them, and the reason the
 * app bounced back (`connectError`) is shown rather than left in the console.
 */
const { t } = useI18n();

useHead({ title: () => t('desktop.welcome.pageTitle') });
definePageMeta({ layout: false });

import { parseConnectionCode } from '~/lib/desktop/connectionCode';

const { isDesktop } = useDesktopContext();
const {
	workspaces,
	activeId,
	addWorkspace,
	completeConnection,
	connectError,
	clearConnectFailure,
	switchTo,
	removeWorkspace,
} = useDesktopWorkspaces();

const siteUrl = ref('');
const isConnecting = ref(false);
const errorMessage = ref('');

// After the system browser opens we wait for the owlat://auth deep link — but
// that link cannot reach unbundled dev builds (macOS registers custom schemes
// only for bundled apps), so the browser page also shows a connection code the
// user can paste here (see lib/desktop/connectionCode.ts).
const browserOpened = ref(false);
const pastedCode = ref('');
const isRedeeming = ref(false);

/** Re-run the browser handshake for an already-connected server. Connecting a
 * known siteUrl re-authenticates that workspace in place (same id), so this
 * repairs the dead session instead of adding a second row for the same host. */
async function reconnect(url: string) {
	siteUrl.value = url;
	await handleAdd();
}

async function handleAdd() {
	errorMessage.value = '';
	clearConnectFailure();
	if (!siteUrl.value.trim()) {
		errorMessage.value = t('desktop.welcome.errors.urlRequired');
		return;
	}
	isConnecting.value = true;
	try {
		// Opens the system browser; the owlat://auth deep link returns and reloads
		// into the new workspace (or the user pastes the fallback code below).
		await addWorkspace(siteUrl.value);
		browserOpened.value = true;
	} catch (e) {
		errorMessage.value = e instanceof Error ? e.message : t('desktop.welcome.errors.connectFailed');
	} finally {
		isConnecting.value = false;
	}
}

async function handlePastedCode() {
	errorMessage.value = '';
	const parsed = parseConnectionCode(pastedCode.value);
	if (!parsed) {
		errorMessage.value = t('desktop.welcome.errors.invalidCode');
		return;
	}
	isRedeeming.value = true;
	try {
		// Reloads into the new workspace on success.
		await completeConnection(parsed);
	} catch (e) {
		errorMessage.value =
			e instanceof Error ? e.message : t('desktop.welcome.errors.codeRedeemFailed');
		isRedeeming.value = false;
	}
}

function startOver() {
	browserOpened.value = false;
	pastedCode.value = '';
	errorMessage.value = '';
}
</script>

<template>
	<div
		class="min-h-screen bg-bg-deep flex flex-col items-center justify-center px-4 text-text-primary"
		:style="isDesktop ? { paddingTop: 'var(--titlebar-h, 44px)' } : undefined"
	>
		<!-- Native window titlebar (this page renders inside the Tauri webview). -->
		<DesktopTitlebar />

		<div v-if="!isDesktop" class="card w-full max-w-md p-8 text-sm text-text-secondary">
			{{ t('desktop.welcome.desktopOnly') }}
		</div>

		<div v-else class="w-full max-w-md">
			<div class="text-center">
				<img src="/owlat.svg" alt="" class="mx-auto mb-6 size-14" />

				<!--
					Two framings for one screen. With nothing connected this is a first
					run. With workspaces present the user was bounced here by a dead
					session, and the first-run copy would be a lie.
				-->
				<template v-if="workspaces.length">
					<h1 class="font-display text-4xl mb-2">{{ t('desktop.welcome.reconnect.heading') }}</h1>
					<p class="text-md text-text-secondary mb-8">
						{{ t('desktop.welcome.reconnect.tagline') }}
					</p>
				</template>
				<template v-else>
					<I18nT
						keypath="desktop.welcome.heading"
						tag="h1"
						class="font-display text-4xl mb-2"
						scope="global"
					>
						<template #brand><span class="italic">Owlat</span></template>
					</I18nT>
					<p class="text-md text-text-secondary mb-8">
						{{ t('desktop.welcome.tagline') }}
					</p>
				</template>
			</div>

			<!-- Why the app bounced back here, when it knows. -->
			<p v-if="connectError && !browserOpened" class="mb-6 text-center text-sm text-error">
				{{ connectError }}
			</p>

			<!--
				The connected servers. Without this the screen is indistinguishable
				from a fresh install: the workspace is saved and active (the titlebar
				even names it) but nothing on the page acknowledges it, so it cannot
				be reconnected, switched to or removed.
			-->
			<ul v-if="workspaces.length" class="mb-6 space-y-1.5">
				<li
					v-for="ws in workspaces"
					:key="ws.id"
					class="flex items-center gap-3 rounded-xl surface-1 px-3 py-2"
				>
					<button
						type="button"
						class="min-w-0 flex-1 text-left"
						:disabled="ws.id === activeId"
						@click="switchTo(ws.id)"
					>
						<span class="block truncate text-sm" :class="ws.id === activeId ? 'font-semibold' : ''">
							{{ ws.label }}
						</span>
						<span class="block truncate text-xs text-text-secondary">{{ ws.siteUrl }}</span>
					</button>
					<UiButton variant="outline" size="sm" class="shrink-0" @click="reconnect(ws.siteUrl)">
						{{ t('desktop.welcome.reconnect.action') }}
					</UiButton>
					<button
						type="button"
						class="shrink-0 text-xs text-text-secondary transition-colors duration-(--motion-fast) hover:text-error"
						@click="removeWorkspace(ws.id)"
					>
						{{ t('common.remove') }}
					</button>
				</li>
			</ul>

			<!-- ============ MAIN: CONNECT TO YOUR WORKSPACE ============ -->
			<section class="card p-6" aria-labelledby="desktop-connect-title">
				<div class="mb-5 flex items-start gap-4">
					<span
						class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand"
					>
						<Icon name="lucide:plug" class="size-5" />
					</span>
					<div class="min-w-0">
						<h2 id="desktop-connect-title" class="text-base font-semibold">
							{{
								workspaces.length
									? t('desktop.welcome.connect.titleAnother')
									: t('desktop.welcome.connect.title')
							}}
						</h2>
						<p class="mt-0.5 text-sm text-text-secondary">
							{{ t('desktop.welcome.connect.description') }}
						</p>
					</div>
				</div>

				<form v-if="!browserOpened" class="space-y-3" @submit.prevent="handleAdd">
					<label class="block text-sm font-medium" for="server-address">
						{{ t('desktop.welcome.connect.urlLabel') }}
					</label>
					<input
						id="server-address"
						v-model="siteUrl"
						type="text"
						inputmode="url"
						autocomplete="url"
						spellcheck="false"
						:placeholder="t('desktop.welcome.connect.urlPlaceholder')"
						class="input input-sm text-sm"
					/>
					<p v-if="errorMessage" class="text-sm text-error">{{ errorMessage }}</p>
					<UiButton type="submit" :disabled="isConnecting" full-width>
						{{
							isConnecting
								? t('desktop.welcome.connect.opening')
								: t('desktop.welcome.connect.submit')
						}}
					</UiButton>
				</form>

				<div v-else class="space-y-4">
					<p class="text-sm text-text-secondary">
						{{ t('desktop.welcome.connect.finishInBrowser') }}
					</p>
					<!-- A deep link that came back and failed: the browser half looks
					     finished, so the reason has to land here. -->
					<p v-if="connectError" class="text-sm text-error">{{ connectError }}</p>
					<form
						class="space-y-3 border-t border-border-subtle pt-4"
						@submit.prevent="handlePastedCode"
					>
						<label class="block text-sm" for="connection-code">
							{{ t('desktop.welcome.connect.pasteCodeLabel') }}
						</label>
						<input
							id="connection-code"
							v-model="pastedCode"
							type="text"
							autocomplete="off"
							spellcheck="false"
							:placeholder="t('desktop.welcome.connect.codePlaceholder')"
							class="input input-sm font-mono text-sm"
						/>
						<p v-if="errorMessage" class="text-sm text-error">{{ errorMessage }}</p>
						<UiButton type="submit" :disabled="isRedeeming || !pastedCode.trim()" full-width>
							{{
								isRedeeming
									? t('desktop.welcome.connect.redeeming')
									: t('desktop.welcome.connect.redeemSubmit')
							}}
						</UiButton>
					</form>
					<button
						type="button"
						class="text-xs text-text-secondary transition-colors duration-(--motion-fast) hover:text-text-primary"
						@click="startOver"
					>
						{{ t('desktop.welcome.connect.startOver') }}
					</button>
				</div>
			</section>

			<!-- ============ SECONDARY: SET UP A NEW SERVER ============ -->
			<NuxtLink
				to="/desktop/setup"
				class="group mt-4 flex w-full items-center gap-3 rounded-xl border border-border-subtle px-4 py-3 text-left transition-colors duration-(--motion-fast) hover:border-brand-border"
			>
				<Icon name="lucide:server" class="size-4 shrink-0 text-text-tertiary" />
				<span class="min-w-0 flex-1">
					<span class="block text-sm font-medium">{{ t('desktop.welcome.setup.title') }}</span>
					<span class="mt-0.5 block text-xs text-text-secondary">{{
						t('desktop.welcome.setup.description')
					}}</span>
				</span>
				<Icon
					name="lucide:arrow-right"
					class="size-4 shrink-0 text-text-tertiary transition-transform duration-(--motion-fast) group-hover:translate-x-[2px] group-hover:text-brand"
				/>
			</NuxtLink>
		</div>
	</div>
</template>
