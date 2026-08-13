<script setup lang="ts">
import { isValidEmail } from '~/utils/validation';

const { t } = useI18n();

useHead({ title: () => t('auth.login.pageTitle') });

definePageMeta({
	middleware: 'guest',
});

const { signInWithEmail } = useAuth();
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
		await signInWithEmail(email.value, password.value);

		// Wait for Vue to process reactive updates before navigating
		await nextTick();

		// Redirect to dashboard or the page user was trying to access (open-redirect-safe)
		await navigateTo(safeRedirect(route.query['redirect'], '/dashboard'));
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

		<form class="space-y-5" @submit.prevent="handleSubmit">
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

		<template #footer>
			{{ t('auth.login.noAccount') }}
			<NuxtLink to="/auth/register" class="link font-medium">
				{{ t('auth.login.createAccount') }}
			</NuxtLink>
		</template>
	</AuthShell>
</template>
