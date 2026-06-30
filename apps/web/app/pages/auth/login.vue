<script setup lang="ts">
import { isValidEmail } from '~/utils/validation';

useHead({ title: 'Login \u2014 Owlat' });

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
		errors.email = 'Email is required';
		return false;
	}
	if (!isValidEmail(email.value)) {
		errors.email = 'Please enter a valid email address';
		return false;
	}
	errors.email = '';
	return true;
}

// Validate password
function validatePassword(): boolean {
	if (!password.value) {
		errors.password = 'Password is required';
		return false;
	}
	if (password.value.length < 10) {
		errors.password = 'Password must be at least 10 characters';
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
	<div class="min-h-screen bg-bg-deep flex flex-col items-center justify-center px-4">
		<!-- Logo/Brand -->
		<div class="mb-8 text-center">
			<h1 class="font-display text-4xl text-text-primary">Owlat</h1>
			<p class="text-text-secondary mt-2">Sign in to your account</p>
		</div>

		<!-- Login Card -->
		<UiCard class="w-full max-w-md">
			<!-- Post-setup success banner -->
			<div
				v-if="justCompletedSetup"
				class="mb-6 p-4 bg-success-subtle border border-success/30 rounded-lg text-success text-sm"
			>
				Your Owlat instance is ready. Sign in with the admin account you just created.
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
					label="Email"
					placeholder="you@example.com"
					:error="errors.email"
					@blur="validateEmail"
				/>

				<!-- Password Field -->
				<UiInput
					id="password"
					v-model="password"
					type="password"
					autocomplete="current-password"
					label="Password"
					placeholder="Enter your password"
					:error="errors.password"
					@blur="validatePassword"
				/>

				<!-- Forgot Password Link -->
			<div class="flex justify-end -mt-1">
				<NuxtLink to="/auth/forgot-password" class="text-sm link">Forgot password?</NuxtLink>
			</div>

			<!-- Submit Button -->
				<UiButton type="submit" size="lg" full-width :loading="isLoading">
					{{ isLoading ? 'Signing in...' : 'Sign in' }}
				</UiButton>
			</form>

			<!-- Register Link -->
			<p class="mt-6 text-center text-text-secondary text-sm">
				Don't have an account?
				<NuxtLink to="/auth/register" class="link font-medium"> Create one </NuxtLink>
			</p>
		</UiCard>
	</div>
</template>
