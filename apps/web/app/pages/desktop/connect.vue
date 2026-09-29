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
import { useCopyToClipboard } from '~/composables/useCopyToClipboard';
import { useSignInValidation } from '~/composables/useSignInValidation';
import { useTwoFactorChallenge } from '~/composables/useTwoFactorChallenge';

const route = useRoute();
const { user, signInWithEmail, completeTwoFactorSignIn, isPending } = useAuth();

const state = computed(() => String(route.query['state'] ?? ''));
const redirect = computed(() => String(route.query['redirect'] ?? ''));
// Open-redirect guard: only ever hand the token back to the desktop scheme.
const redirectValid = computed(() => redirect.value.startsWith('owlat://'));

const email = ref('');
const password = ref('');
const { isLoading, errorMessage, submit } = useAuthForm();
const { errors, validateEmail, validatePassword, validate } = useSignInValidation(email, password);
const handingBack = ref(false);
// Deep-link fallback: the same payload as a paste-able code, for environments
// where the `owlat://` link never reaches the app (macOS `tauri dev` binaries,
// browsers that refuse custom schemes). See lib/desktop/connectionCode.ts.
const connectionCode = ref('');
const { copy, copiedKey } = useCopyToClipboard();
// A failed copy needs no message: the code is selectable text, copy by hand.
const copyCode = () => copy(connectionCode.value);

/**
 * Sign-in is two stages once the account has TOTP enabled: BetterAuth answers
 * the password POST with `{ twoFactorRedirect: true }` and NO session, so the
 * `user` watcher below never fires and there is nothing to hand back yet. The
 * challenge is a stage of THIS form — the desktop handshake has nowhere to
 * navigate to, and the `state` nonce lives in the query string of this very URL.
 * State and markup are the sign-in page's (`useTwoFactorChallenge`,
 * `AuthTwoFactorStageForm`).
 */
const twoFactor = useTwoFactorChallenge({
	onSwitch: () => {
		errorMessage.value = '';
	},
	onReset: () => {
		password.value = '';
		errorMessage.value = '';
	},
});
const {
	stage,
	code: twoFactorCode,
	method: twoFactorMethod,
	canSubmit: canSubmitCode,
	challenge,
	reset: resetChallenge,
} = twoFactor;

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
	if (!validate()) return;
	await submit(async () => {
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
	}, t('desktop.connect.errors.signInFailed'));
}

async function handleTwoFactorSubmit() {
	if (!canSubmitCode.value) return;
	await submit(async () => {
		await completeTwoFactorSignIn({ code: twoFactorCode.value, method: twoFactorMethod.value });
		await nextTick();
		// Same tail as the one-stage sign-in: the `user` watcher hands the token
		// back once the session resolves.
	}, t('desktop.connect.errors.signInFailed'));
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
							{{ copiedKey ? t('desktop.connect.copied') : t('common.copy') }}
						</UiButton>
					</div>
				</div>
			</div>

			<form v-else-if="stage === 'credentials'" class="space-y-4" @submit.prevent="handleSubmit">
				<UiInput
					id="email"
					v-model="email"
					type="email"
					autocomplete="email"
					size="sm"
					:label="t('common.email')"
					:error="errors.email"
					@blur="validateEmail"
				/>
				<AuthPasswordInput
					id="password"
					v-model="password"
					autocomplete="current-password"
					:label="t('desktop.connect.password')"
					:error="errors.password"
					@blur="validatePassword"
				/>
				<p v-if="errorMessage" class="text-sm text-error">{{ errorMessage }}</p>
				<UiButton type="submit" :loading="isLoading" full-width>
					{{ isLoading ? t('desktop.connect.signingInButton') : t('desktop.connect.submit') }}
				</UiButton>
			</form>

			<!--
				Second stage. The password has already been accepted; the server is
				holding the session behind a short-lived challenge cookie. The form is
				the sign-in page's: the same question, asked by the same product.
			-->
			<AuthTwoFactorStageForm
				v-else
				:challenge="twoFactor"
				:is-loading="isLoading"
				:error-message="errorMessage"
				compact
				@submit="handleTwoFactorSubmit"
				@cancel="resetChallenge"
			/>
		</div>
	</div>
</template>
