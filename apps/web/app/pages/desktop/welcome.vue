<script setup lang="ts">
/**
 * Desktop landing flow. Shown when running in the desktop app with no active
 * workspace (gated by middleware/desktop-workspace.global.ts), and reachable
 * to add/switch workspaces.
 *
 * Two steps: a branded welcome with the core choice (connect an existing
 * server vs. provision a new one), then the workspace connector form.
 */
useHead({ title: 'Welcome — Owlat' });
definePageMeta({ layout: false });

import { parseConnectionCode } from '~/lib/desktop/connectionCode';

const { isDesktop } = useDesktopContext();
const { workspaces, activeId, addWorkspace, completeConnection, switchTo, removeWorkspace } =
	useDesktopWorkspaces();

const view = ref<'welcome' | 'connect'>('welcome');

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

async function handleAdd() {
	errorMessage.value = '';
	if (!siteUrl.value.trim()) {
		errorMessage.value = 'Enter your owlat server URL.';
		return;
	}
	isConnecting.value = true;
	try {
		// Opens the system browser; the owlat://auth deep link returns and reloads
		// into the new workspace (or the user pastes the fallback code below).
		await addWorkspace(siteUrl.value);
		browserOpened.value = true;
	} catch (e) {
		errorMessage.value = e instanceof Error ? e.message : 'Could not connect to that server.';
	} finally {
		isConnecting.value = false;
	}
}

async function handlePastedCode() {
	errorMessage.value = '';
	const parsed = parseConnectionCode(pastedCode.value);
	if (!parsed) {
		errorMessage.value = 'That does not look like a connection code.';
		return;
	}
	isRedeeming.value = true;
	try {
		// Reloads into the new workspace on success.
		await completeConnection(parsed);
	} catch (e) {
		errorMessage.value =
			e instanceof Error ? e.message : 'Could not connect with that code — try signing in again.';
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
		:class="{ 'pt-[44px]': isDesktop }"
	>
		<!-- Native window titlebar (this page renders inside the Tauri webview). -->
		<DesktopTitlebar />

		<div
			v-if="!isDesktop"
			class="w-full max-w-md rounded-2xl border border-border-default bg-bg-surface p-8 text-sm text-text-secondary"
		>
			The workspace connector is only available in the desktop app.
		</div>

		<!-- ============ STEP 1: WELCOME ============ -->
		<div v-else-if="view === 'welcome'" class="w-full max-w-md text-center">
			<img src="/owlat.svg" alt="" class="mx-auto mb-6 size-14" />
			<h1 class="font-display text-4xl mb-2">Welcome to Owlat</h1>
			<p class="text-sm text-text-secondary mb-10">
				Your self-hosted home for email, contacts and marketing.
			</p>

			<NuxtLink
				to="/desktop/setup"
				class="group flex w-full items-center gap-4 rounded-2xl border-2 border-brand bg-brand-subtle p-5 text-left transition-colors hover:bg-brand/10"
			>
				<span
					class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand text-white"
				>
					<Icon name="lucide:server" class="size-5" />
				</span>
				<span class="min-w-0 flex-1">
					<span class="block text-sm font-semibold">Set up a new server</span>
					<span class="mt-0.5 block text-xs text-text-secondary"
						>Install Owlat on a fresh Linux server over SSH.</span
					>
				</span>
				<Icon name="lucide:chevron-right" class="size-4 shrink-0 text-brand" />
			</NuxtLink>

			<p class="mt-5 text-xs text-text-secondary">
				Already have a server?
				<button
					type="button"
					class="font-medium text-brand hover:text-brand-hover"
					@click="view = 'connect'"
				>
					Connect an existing server →
				</button>
			</p>
		</div>

		<!-- ============ STEP 2: CONNECT ============ -->
		<div v-else class="w-full max-w-md rounded-2xl border border-border-default bg-bg-surface p-8">
			<button
				type="button"
				class="mb-4 inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary"
				@click="view = 'welcome'"
			>
				<Icon name="lucide:arrow-left" class="size-3.5" /> Back
			</button>

			<h1 class="text-xl font-semibold mb-1">Connect to your Owlat server</h1>
			<p class="text-sm text-text-secondary mb-6">
				Enter the address of your Owlat instance. You'll sign in through your browser.
			</p>

			<form v-if="!browserOpened" class="space-y-3" @submit.prevent="handleAdd">
				<input
					v-model="siteUrl"
					type="text"
					inputmode="url"
					placeholder="https://your-instance.owlat.app"
					class="w-full rounded-lg border border-border-default bg-bg-deep px-3 py-2 text-sm"
				/>
				<p v-if="errorMessage" class="text-sm text-red-400">{{ errorMessage }}</p>
				<button
					type="submit"
					:disabled="isConnecting"
					class="w-full rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
				>
					{{ isConnecting ? 'Opening browser…' : 'Connect workspace' }}
				</button>
			</form>

			<div v-else class="space-y-4">
				<p class="text-sm text-text-secondary">
					Finish signing in in your browser — this app reconnects automatically.
				</p>
				<form
					class="space-y-3 border-t border-border-default pt-4"
					@submit.prevent="handlePastedCode"
				>
					<label class="block text-sm" for="connection-code">
						Nothing happening? Paste the connection code shown in the browser:
					</label>
					<input
						id="connection-code"
						v-model="pastedCode"
						type="text"
						autocomplete="off"
						spellcheck="false"
						placeholder="e.g. 4f2c…:Jh…"
						class="w-full rounded-lg border border-border-default bg-bg-deep px-3 py-2 text-sm font-mono"
					/>
					<p v-if="errorMessage" class="text-sm text-red-400">{{ errorMessage }}</p>
					<button
						type="submit"
						:disabled="isRedeeming || !pastedCode.trim()"
						class="w-full rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
					>
						{{ isRedeeming ? 'Connecting…' : 'Connect with code' }}
					</button>
				</form>
				<button
					type="button"
					class="text-xs text-text-secondary hover:text-text-primary"
					@click="startOver"
				>
					Start over
				</button>
			</div>

			<div v-if="workspaces.length" class="mt-8">
				<h2 class="text-xs font-medium uppercase tracking-wide text-text-secondary mb-2">
					Your workspaces
				</h2>
				<ul class="space-y-1">
					<li
						v-for="ws in workspaces"
						:key="ws.id"
						class="flex items-center justify-between rounded-lg border border-border-default px-3 py-2"
					>
						<button
							class="flex-1 text-left text-sm"
							:class="ws.id === activeId ? 'font-semibold' : ''"
							@click="switchTo(ws.id)"
						>
							{{ ws.label }}
							<span class="block text-xs text-text-secondary">{{ ws.siteUrl }}</span>
						</button>
						<button
							class="ml-3 text-xs text-text-secondary hover:text-red-400"
							@click="removeWorkspace(ws.id)"
						>
							Remove
						</button>
					</li>
				</ul>
			</div>
		</div>
	</div>
</template>
