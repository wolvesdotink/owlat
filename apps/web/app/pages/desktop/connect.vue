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
const { t } = useI18n();

useHead({ title: () => t('desktop.connect.pageTitle') });
definePageMeta({ layout: false });

import { formatConnectionCode } from '~/lib/desktop/connectionCode';
import { requiresTwoFactor } from '~/utils/accountTwoFactor';
import { useTwoFactorChallenge } from '~/composables/useTwoFactorChallenge';

const route = useRoute();
const { user, signInWithEmail, completeTwoFactorSignIn, isPending } = useAuth();

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

/**
 * Sign-in is two stages once the account has TOTP enabled: BetterAuth answers
 * the password POST with `{ twoFactorRedirect: true }` and NO session, so the
 * `user` watcher below never fires and there is nothing to hand back yet. The
 * challenge is a stage of THIS form — the desktop handshake has nowhere to
 * navigate to, and the `state` nonce lives in the query string of this very URL.
 */
const {
	stage,
	code: twoFactorCode,
	useBackupCode,
	method: twoFactorMethod,
	canSubmit: canSubmitCode,
	onCodeInput,
	challenge,
	switchMethod,
	reset: resetChallenge,
} = useTwoFactorChallenge();

function switchCodeMethod() {
	switchMethod();
	errorMessage.value = '';
}

function backToCredentials() {
	resetChallenge();
	password.value = '';
	errorMessage.value = '';
}

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
		if (!res.ok) throw new Error(t('desktop.connect.errors.tokenRequestFailed'));
		const data = (await res.json()) as { token?: string };
		if (!data.token) throw new Error(t('desktop.connect.errors.noToken'));
		connectionCode.value = formatConnectionCode(state.value, data.token);
		window.location.href = `${redirect.value}?ott=${encodeURIComponent(data.token)}&state=${encodeURIComponent(state.value)}`;
	} catch (e) {
		errorMessage.value = e instanceof Error ? e.message : t('desktop.connect.errors.generic');
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
		errorMessage.value = t('desktop.connect.errors.credentialsRequired');
		return;
	}
	isLoading.value = true;
	try {
		const result = await signInWithEmail(email.value, password.value);
		// The password was right but the account wants its second factor. No
		// session exists, so waiting on the `user` watcher here would hang the
		// page on a silent, empty form.
		if (requiresTwoFactor(result)) {
			challenge();
			return;
		}
		await nextTick();
		// The `user` watcher fires `generateAndReturn` once the session resolves.
	} catch (e) {
		errorMessage.value = e instanceof Error ? e.message : t('desktop.connect.errors.signInFailed');
	} finally {
		isLoading.value = false;
	}
}

async function handleTwoFactorSubmit() {
	if (!canSubmitCode.value) return;
	errorMessage.value = '';
	isLoading.value = true;
	try {
		await completeTwoFactorSignIn({ code: twoFactorCode.value, method: twoFactorMethod.value });
		await nextTick();
		// Same tail as the one-stage sign-in: the `user` watcher hands the token
		// back once the session resolves.
	} catch (e) {
		errorMessage.value = e instanceof Error ? e.message : t('desktop.connect.errors.signInFailed');
	} finally {
		isLoading.value = false;
	}
}
</script>

<template>
	<div
		class="min-h-screen bg-bg-deep flex flex-col items-center justify-center px-4 text-text-primary"
	>
		<div class="card w-full max-w-sm p-8">
			<h1 class="text-xl font-medium tracking-[-0.01em] mb-1">{{ t('desktop.connect.title') }}</h1>
			<p class="text-sm text-text-secondary mb-6">
				{{ t('desktop.connect.subtitle') }}
			</p>

			<div v-if="!redirectValid" class="text-sm text-error">
				{{ t('desktop.connect.invalidReturnLink') }}
			</div>

			<div v-else-if="handingBack || (user && !isPending)" class="text-sm text-text-secondary">
				<p>{{ t('desktop.connect.signingIn') }}</p>
				<div v-if="connectionCode" class="mt-6 border-t border-border-subtle pt-4">
					<p class="mb-2">
						{{ t('desktop.connect.fallbackCodeHint') }}
					</p>
					<div class="flex items-center gap-2">
						<code
							class="min-w-0 flex-1 truncate rounded-xl bg-bg-deep px-3 py-2 text-xs select-all shadow-surface-1"
						>
							{{ connectionCode }}
						</code>
						<UiButton variant="outline" size="sm" class="shrink-0" @click="copyCode">
							{{ codeCopied ? t('desktop.connect.copied') : t('common.copy') }}
						</UiButton>
					</div>
				</div>
			</div>

			<form v-else-if="stage === 'credentials'" class="space-y-4" @submit.prevent="handleSubmit">
				<div>
					<label class="label mb-1 text-sm" for="email">{{ t('common.email') }}</label>
					<input
						id="email"
						v-model="email"
						type="email"
						autocomplete="email"
						class="input input-sm text-sm"
					/>
				</div>
				<div>
					<label class="label mb-1 text-sm" for="password">{{
						t('desktop.connect.password')
					}}</label>
					<input
						id="password"
						v-model="password"
						type="password"
						autocomplete="current-password"
						class="input input-sm text-sm"
					/>
				</div>
				<p v-if="errorMessage" class="text-sm text-error">{{ errorMessage }}</p>
				<UiButton type="submit" :disabled="isLoading" full-width>
					{{ isLoading ? t('desktop.connect.signingInButton') : t('desktop.connect.submit') }}
				</UiButton>
			</form>

			<!--
				Second stage. The password has already been accepted; the server is
				holding the session behind a short-lived challenge cookie. The copy is
				the sign-in page's — it is the same question, asked by the same
				product, and a second set of keys would only drift from the first.
			-->
			<form v-else class="space-y-4" @submit.prevent="handleTwoFactorSubmit">
				<div>
					<h2 class="text-sm font-medium">{{ t('auth.login.twoFactor.title') }}</h2>
					<p class="mt-1 text-sm text-text-secondary">
						{{
							useBackupCode ? t('auth.login.twoFactor.backupBody') : t('auth.login.twoFactor.body')
						}}
					</p>
				</div>
				<div>
					<label class="label mb-1 text-sm" for="two-factor-code">{{
						useBackupCode
							? t('auth.login.twoFactor.backupLabel')
							: t('auth.login.twoFactor.codeLabel')
					}}</label>
					<input
						id="two-factor-code"
						:value="twoFactorCode"
						:autocomplete="useBackupCode ? 'off' : 'one-time-code'"
						type="text"
						class="input input-sm text-sm"
						@input="onCodeInput(($event.target as HTMLInputElement).value)"
					/>
				</div>
				<p v-if="errorMessage" class="text-sm text-error">{{ errorMessage }}</p>
				<UiButton type="submit" :disabled="isLoading || !canSubmitCode" full-width>
					{{ isLoading ? t('auth.login.twoFactor.submitting') : t('auth.login.twoFactor.submit') }}
				</UiButton>
				<div class="flex items-center justify-between text-sm">
					<button type="button" class="link" @click="switchCodeMethod">
						{{
							useBackupCode
								? t('auth.login.twoFactor.useAuthenticator')
								: t('auth.login.twoFactor.useBackupCode')
						}}
					</button>
					<button type="button" class="link" @click="backToCredentials">
						{{ t('auth.login.twoFactor.cancel') }}
					</button>
				</div>
			</form>
		</div>
	</div>
</template>
