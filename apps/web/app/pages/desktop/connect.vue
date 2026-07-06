<script setup lang="ts">
/**
 * Desktop sign-in handshake page (runs in the system browser, on the instance).
 *
 * The desktop app opens this page with `?state=<nonce>&redirect=owlat://auth`.
 * The user signs in normally (cookie session on the instance origin); we then
 * mint a one-time token bound to that session and hand it back to the app via
 * the `owlat://auth?ott=...&state=...` deep link. The desktop redeems it for a
 * cross-domain session (see useDesktopWorkspaces.completeConnection).
 */
useHead({ title: 'Connect desktop app — Owlat' });
definePageMeta({ layout: false });

import { formatConnectionCode } from '~/lib/desktop/connectionCode';

const route = useRoute();
const { user, signInWithEmail, isPending } = useAuth();

const state = computed(() => String(route.query['state'] ?? ''));
const redirect = computed(() => String(route.query['redirect'] ?? ''));
// Open-redirect guard: only ever hand the token back to the desktop scheme.
const redirectValid = computed(() => redirect.value.startsWith('owlat://'));

const email = ref('');
const password = ref('');
const isLoading = ref(false);
const errorMessage = ref('');
const handingBack = ref(false);
// Deep-link fallback: the same payload as a paste-able code, for environments
// where the `owlat://` link never reaches the app (macOS `tauri dev` binaries,
// browsers that refuse custom schemes). See lib/desktop/connectionCode.ts.
const connectionCode = ref('');
const codeCopied = ref(false);

async function copyCode() {
	try {
		await navigator.clipboard.writeText(connectionCode.value);
		codeCopied.value = true;
		setTimeout(() => (codeCopied.value = false), 2000);
	} catch {
		// Clipboard unavailable — the code is selectable text, copy by hand.
	}
}

async function generateAndReturn() {
	if (handingBack.value) return;
	handingBack.value = true;
	try {
		// /api/auth/* is proxied to Convex by the instance's Nitro server; the
		// session cookie authorizes the one-time-token generation.
		const res = await fetch('/api/auth/one-time-token/generate', { credentials: 'include' });
		if (!res.ok) throw new Error('Could not create a sign-in token.');
		const data = (await res.json()) as { token?: string };
		if (!data.token) throw new Error('No token returned by the server.');
		connectionCode.value = formatConnectionCode(state.value, data.token);
		window.location.href = `${redirect.value}?ott=${encodeURIComponent(data.token)}&state=${encodeURIComponent(state.value)}`;
	} catch (e) {
		errorMessage.value = e instanceof Error ? e.message : 'Something went wrong.';
		handingBack.value = false;
	}
}

// Already signed in? Hand a token straight back.
watch(
	[user, isPending],
	([u, pending]) => {
		if (!pending && u && redirectValid.value && state.value) {
			void generateAndReturn();
		}
	},
	{ immediate: true }
);

async function handleSubmit() {
	errorMessage.value = '';
	if (!email.value || !password.value) {
		errorMessage.value = 'Email and password are required.';
		return;
	}
	isLoading.value = true;
	try {
		await signInWithEmail(email.value, password.value);
		await nextTick();
		// The `user` watcher fires `generateAndReturn` once the session resolves.
	} catch (e) {
		errorMessage.value = e instanceof Error ? e.message : 'Sign-in failed.';
	} finally {
		isLoading.value = false;
	}
}
</script>

<template>
	<div
		class="min-h-screen bg-bg-deep flex flex-col items-center justify-center px-4 text-text-primary"
	>
		<div class="w-full max-w-sm rounded-2xl border border-border-default bg-bg-surface p-8">
			<h1 class="text-xl font-semibold mb-1">Connect the desktop app</h1>
			<p class="text-sm text-text-secondary mb-6">
				Sign in to link this workspace to the Owlat desktop app.
			</p>

			<div v-if="!redirectValid" class="text-sm text-red-400">
				Invalid or missing return link. Re-open this page from the desktop app.
			</div>

			<div v-else-if="handingBack || (user && !isPending)" class="text-sm text-text-secondary">
				<p>Signing you in to the desktop app…</p>
				<div v-if="connectionCode" class="mt-6 border-t border-border-default pt-4">
					<p class="mb-2">
						Desktop app didn't open? Paste this code into its connect screen (valid for a few
						minutes):
					</p>
					<div class="flex items-center gap-2">
						<code
							class="min-w-0 flex-1 truncate rounded-lg border border-border-default bg-bg-deep px-3 py-2 text-xs select-all"
						>
							{{ connectionCode }}
						</code>
						<button
							type="button"
							class="shrink-0 rounded-lg border border-border-default px-3 py-2 text-xs hover:text-text-primary"
							@click="copyCode"
						>
							{{ codeCopied ? 'Copied!' : 'Copy' }}
						</button>
					</div>
				</div>
			</div>

			<form v-else class="space-y-4" @submit.prevent="handleSubmit">
				<div>
					<label class="block text-sm mb-1" for="email">Email</label>
					<input
						id="email"
						v-model="email"
						type="email"
						autocomplete="email"
						class="w-full rounded-lg border border-border-default bg-bg-deep px-3 py-2 text-sm"
					/>
				</div>
				<div>
					<label class="block text-sm mb-1" for="password">Password</label>
					<input
						id="password"
						v-model="password"
						type="password"
						autocomplete="current-password"
						class="w-full rounded-lg border border-border-default bg-bg-deep px-3 py-2 text-sm"
					/>
				</div>
				<p v-if="errorMessage" class="text-sm text-red-400">{{ errorMessage }}</p>
				<button
					type="submit"
					:disabled="isLoading"
					class="w-full rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
				>
					{{ isLoading ? 'Signing in…' : 'Sign in & connect' }}
				</button>
			</form>
		</div>
	</div>
</template>
