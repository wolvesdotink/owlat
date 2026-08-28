<script setup lang="ts">
import { isValidEmail } from '~/utils/validation';
import { isCompleteTotpCode, normalizeTotpCode, requiresTwoFactor } from '~/utils/accountTwoFactor';

const { t } = useI18n();

useHead({ title: () => t('auth.login.pageTitle') });

definePageMeta({
	middleware: 'guest',
});

const { signInWithEmail, completeTwoFactorSignIn } = useAuth();
const route = useRoute();

// Coming out of the first-run setup wizard: show a success banner and pre-fill
// the admin email so the just-created account is one keystroke from signing in.
const justCompletedSetup = computed(() => route.query['postSetup'] === '1');
const prefilledEmail = typeof route.query['email'] === 'string' ? route.query['email'] : '';

// Form state
const email = ref(prefilledEmail);
const password = ref('');
const { isLoading, errorMessage, submit } = useAuthForm();

// Field-level validation errors
const errors = reactive({
	email: '',
	password: '',
});

/**
 * Sign-in is two stages once an account has TOTP enabled. BetterAuth answers the
 * password POST with `{ twoFactorRedirect: true }` and NO session, so navigating
 * on that response would land on a dashboard the user is not signed in to. The
 * challenge is a stage of THIS form rather than its own route: the desktop app
 * ships the same page and has nowhere to navigate to, and a route would put the
 * half-finished sign-in in the browser's history.
 */
const stage = ref<'credentials' | 'two-factor'>('credentials');
const twoFactorCode = ref('');
/** The fallback for a lost authenticator. A different endpoint, not a format. */
const useBackupCode = ref(false);

function onCodeInput(value: string) {
	// Backup codes are not six digits and must not be filtered down to their
	// digits; only the TOTP field is normalised.
	twoFactorCode.value = useBackupCode.value ? value.trim() : normalizeTotpCode(value);
}

const canSubmitCode = computed(() =>
	useBackupCode.value ? twoFactorCode.value.length > 0 : isCompleteTotpCode(twoFactorCode.value)
);

function switchCodeMethod() {
	useBackupCode.value = !useBackupCode.value;
	twoFactorCode.value = '';
	errorMessage.value = '';
}

function backToCredentials() {
	stage.value = 'credentials';
	twoFactorCode.value = '';
	useBackupCode.value = false;
	password.value = '';
	errorMessage.value = '';
}

// Validate email
function validateEmail(): boolean {
	if (!email.value) {
		errors.email = t('auth.validation.emailRequired');
		return false;
	}
	if (!isValidEmail(email.value)) {
		errors.email = t('auth.validation.emailInvalid');
		return false;
	}
	errors.email = '';
	return true;
}

// Validate password
function validatePassword(): boolean {
	if (!password.value) {
		errors.password = t('auth.validation.passwordRequired');
		return false;
	}
	if (password.value.length < 10) {
		errors.password = t('auth.validation.passwordTooShort');
		return false;
	}
	errors.password = '';
	return true;
}

// Validate all fields
function validateForm(): boolean {
	const emailValid = validateEmail();
	const passwordValid = validatePassword();
	return emailValid && passwordValid;
}

// Handle form submission
async function handleSubmit() {
	if (!validateForm()) {
		return;
	}

	await submit(async () => {
		const result = await signInWithEmail(email.value, password.value);

		// The password was right but the account wants its second factor. No
		// session exists yet, so this must NOT fall through to the redirect.
		if (requiresTwoFactor(result)) {
			stage.value = 'two-factor';
			return;
		}

		await finishSignIn();
	});
}

/** Shared tail of both stages: settle reactivity, then leave for the app. */
async function finishSignIn() {
	// Wait for Vue to process reactive updates before navigating
	await nextTick();

	// Redirect to dashboard or the page user was trying to access (open-redirect-safe)
	await navigateTo(safeRedirect(route.query['redirect'], '/dashboard'));
}

async function handleTwoFactorSubmit() {
	if (!canSubmitCode.value) return;

	await submit(async () => {
		await completeTwoFactorSignIn({
			code: twoFactorCode.value,
			method: useBackupCode.value ? 'backup-code' : 'totp',
		});
		await finishSignIn();
	});
}
</script>

<template>
	<AuthShell :subtitle="t('auth.login.tagline')">
		<template #title>
			{{ t('auth.login.title') }}
			<span class="lp-title-accent">{{ t('auth.login.titleAccent') }}</span>
		</template>

		<!-- Post-setup success banner -->
		<div
			v-if="justCompletedSetup"
			class="mb-6 p-4 bg-success-subtle border border-success/30 rounded-lg text-success text-sm"
		>
			{{ t('auth.login.postSetupBanner') }}
		</div>

		<!-- Error Message -->
		<div
			v-if="errorMessage"
			class="mb-6 p-4 bg-error-subtle border border-error/30 rounded-lg text-error text-sm"
		>
			{{ errorMessage }}
		</div>

		<form v-if="stage === 'credentials'" class="space-y-5" @submit.prevent="handleSubmit">
			<!-- Email Field -->
			<UiInput
				id="email"
				v-model="email"
				type="email"
				autocomplete="email"
				:label="t('auth.fields.email')"
				:placeholder="t('auth.fields.emailPlaceholder')"
				:error="errors.email"
				@blur="validateEmail"
			/>

			<!-- Password Field -->
			<UiInput
				id="password"
				v-model="password"
				type="password"
				autocomplete="current-password"
				:label="t('auth.fields.password')"
				:placeholder="t('auth.login.passwordPlaceholder')"
				:error="errors.password"
				@blur="validatePassword"
			/>

			<!-- Forgot Password Link -->
			<div class="flex justify-end -mt-1">
				<NuxtLink to="/auth/forgot-password" class="text-sm link">{{
					t('auth.login.forgotPassword')
				}}</NuxtLink>
			</div>

			<!-- Submit Button -->
			<UiButton type="submit" size="lg" full-width :loading="isLoading">
				{{ isLoading ? t('auth.login.submitting') : t('auth.login.submit') }}
			</UiButton>
		</form>

		<!--
			Second stage. The password has already been accepted; the server is
			holding the session behind a short-lived challenge cookie, so this form
			replaces the first rather than sitting beside it.
		-->
		<form v-else class="space-y-5" @submit.prevent="handleTwoFactorSubmit">
			<div>
				<h2 class="font-medium">{{ t('auth.login.twoFactor.title') }}</h2>
				<p class="text-sm text-text-secondary mt-1">
					{{
						useBackupCode ? t('auth.login.twoFactor.backupBody') : t('auth.login.twoFactor.body')
					}}
				</p>
			</div>

			<UiInput
				id="two-factor-code"
				:model-value="twoFactorCode"
				:autocomplete="useBackupCode ? 'off' : 'one-time-code'"
				:label="
					useBackupCode
						? t('auth.login.twoFactor.backupLabel')
						: t('auth.login.twoFactor.codeLabel')
				"
				autofocus
				@update:model-value="(value: string | number) => onCodeInput(String(value))"
			/>

			<UiButton type="submit" size="lg" full-width :loading="isLoading" :disabled="!canSubmitCode">
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

		<template #footer>
			{{ t('auth.login.noAccount') }}
			<NuxtLink to="/auth/register" class="link font-medium">
				{{ t('auth.login.createAccount') }}
			</NuxtLink>
		</template>
	</AuthShell>
</template>
