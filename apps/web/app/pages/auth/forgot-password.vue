<script setup lang="ts">
import { isValidEmail } from '~/utils/validation';

useHead({ title: 'Forgot Password — Owlat' });

definePageMeta({
	middleware: 'guest',
});

const { forgotPassword } = useAuth();

// Form state
const email = ref('');
const isLoading = ref(false);
const errorMessage = ref('');
const isSuccess = ref(false);

// Field-level validation
const emailError = ref('');

function validateEmail(): boolean {
	if (!email.value) {
		emailError.value = 'Email is required';
		return false;
	}
	if (!isValidEmail(email.value)) {
		emailError.value = 'Please enter a valid email address';
		return false;
	}
	emailError.value = '';
	return true;
}

async function handleSubmit() {
	errorMessage.value = '';

	if (!validateEmail()) {
		return;
	}

	isLoading.value = true;

	try {
		await forgotPassword(email.value);
		// Always show success to prevent account enumeration
		isSuccess.value = true;
	} catch (error) {
		// Still show success to prevent account enumeration
		isSuccess.value = true;
	} finally {
		isLoading.value = false;
	}
}
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex flex-col items-center justify-center px-4">
		<!-- Logo/Brand -->
		<div class="mb-8 text-center">
			<h1 class="font-display text-4xl text-text-primary">Owlat</h1>
			<p class="text-text-secondary mt-2">Reset your password</p>
		</div>

		<UiCard class="w-full max-w-md">
			<!-- Success State -->
			<div v-if="isSuccess" class="text-center">
				<div class="mb-4 text-4xl">&#9993;</div>
				<h2 class="text-lg font-semibold text-text-primary mb-2">Check your email</h2>
				<p class="text-text-secondary text-sm mb-6">
					If an account exists for <strong class="text-text-primary">{{ email }}</strong>, we've sent a password reset link. It may take a few minutes to arrive.
				</p>
				<NuxtLink to="/auth/login" class="link font-medium text-sm">
					Back to login
				</NuxtLink>
			</div>

			<!-- Form State -->
			<template v-else>
				<!-- Error Message -->
				<div
					v-if="errorMessage"
					class="mb-6 p-4 bg-error-subtle border border-error/30 rounded-lg text-error text-sm"
				>
					{{ errorMessage }}
				</div>

				<p class="text-text-secondary text-sm mb-6">
					Enter your email address and we'll send you a link to reset your password.
				</p>

				<form class="space-y-5" @submit.prevent="handleSubmit">
					<UiInput
						id="email"
						v-model="email"
						type="email"
						autocomplete="email"
						label="Email"
						placeholder="you@example.com"
						:error="emailError"
						@blur="validateEmail"
					/>

					<UiButton type="submit" size="lg" full-width :loading="isLoading">
						{{ isLoading ? 'Sending...' : 'Send reset link' }}
					</UiButton>
				</form>

				<p class="mt-6 text-center text-text-secondary text-sm">
					<NuxtLink to="/auth/login" class="link font-medium">Back to login</NuxtLink>
				</p>
			</template>
		</UiCard>
	</div>
</template>
