<script setup lang="ts">
import { requiresTwoFactor } from '~/utils/accountTwoFactor';
import { useSignInValidation } from '~/composables/useSignInValidation';
import { useTwoFactorChallenge } from '~/composables/useTwoFactorChallenge';
import { registrationOpenFor, workspaceDisplayName } from '~/utils/instanceEntry';

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

// The instance's root is this page, so it greets visitors with the workspace's
// name rather than the product's: the operator's NUXT_PUBLIC_COMPANY_NAME when
// set, otherwise the name the workspace sends mail under (the same public,
// unauthenticated read the unsubscribe pages use).
const configuredWorkspaceName = workspaceDisplayName(useRuntimeConfig().public);
const { senderName } = useRecipientSender();
const workspaceName = computed(() => configuredWorkspaceName ?? senderName.value);

// Registration is invite-only: "Create an account" only leads anywhere when
// this sign-in was reached from an invitation, so it is offered only then —
// pointing at the same invitation the register form needs.
const canRegister = computed(() => registrationOpenFor(route.query['redirect']));
const registerHref = computed(() => ({
	path: '/auth/register',
	query: { redirect: route.query['redirect'] as string },
}));
const prefilledEmail = typeof route.query['email'] === 'string' ? route.query['email'] : '';

// Form state
const email = ref(prefilledEmail);
const password = ref('');
const { isLoading, errorMessage, submit } = useAuthForm();

const { errors, validateEmail, validatePassword, validate } = useSignInValidation(email, password);

/**
 * Sign-in is two stages once an account has TOTP enabled. BetterAuth answers the
 * password POST with `{ twoFactorRedirect: true }` and NO session, so navigating
 * on that response would land on a dashboard the user is not signed in to. The
 * challenge is a stage of THIS form rather than its own route: the desktop
 * connect handshake needs the same stage with nowhere to navigate to, and a
 * route would put the half-finished sign-in in the browser's history. State and
 * markup are shared with that page (`pages/desktop/connect.vue`) through
 * `useTwoFactorChallenge` and `AuthTwoFactorStageForm`.
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

// Handle form submission
async function handleSubmit() {
	if (!validate()) {
		return;
	}

	await submit(async () => {
		const result = await signInWithEmail(email.value, password.value);

		// The password was right but the account wants its second factor. No
		// session exists yet, so this must NOT fall through to the redirect.
		if (requiresTwoFactor(result)) {
			challenge();
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
		await completeTwoFactorSignIn({ code: twoFactorCode.value, method: twoFactorMethod.value });
		await finishSignIn();
	});
}
</script>

<template>
	<AuthShell :subtitle="workspaceName ? t('auth.login.workspaceTagline') : t('auth.login.tagline')">
		<template #title>
			<template v-if="workspaceName">{{ workspaceName }}</template>
			<template v-else>
				{{ t('auth.login.title') }}
				<span class="lp-title-accent">{{ t('auth.login.titleAccent') }}</span>
			</template>
		</template>

		<!-- Post-setup success banner -->
		<div
			v-if="justCompletedSetup"
			class="mb-6 p-4 bg-success-subtle border border-success/30 rounded-lg text-success text-sm"
		>
			{{ t('auth.login.postSetupBanner') }}
		</div>

		<!-- Error Message (the code stage shows its own, on the code field) -->
		<div
			v-if="errorMessage && stage === 'credentials'"
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
			<AuthPasswordInput
				id="password"
				v-model="password"
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
		<AuthTwoFactorStageForm
			v-else
			:challenge="twoFactor"
			:is-loading="isLoading"
			:error-message="errorMessage"
			@submit="handleTwoFactorSubmit"
			@cancel="resetChallenge"
		/>

		<template #footer>
			<p v-if="canRegister">
				{{ t('auth.login.noAccount') }}
				<NuxtLink :to="registerHref" class="link font-medium">
					{{ t('auth.login.createAccount') }}
				</NuxtLink>
			</p>
			<AuthLegalFooter />
		</template>
	</AuthShell>
</template>
