<script setup lang="ts">
useHead({ title: 'Reset Password — Owlat' });

definePageMeta({
	middleware: 'guest',
});

const { resetPassword } = useAuth();
const route = useRoute();

const token = computed(() => (route.query['token'] as string) || '');

// Form state
const newPassword = ref('');
const confirmPassword = ref('');
const { isLoading, errorMessage, submit } = useAuthForm();
const isSuccess = ref(false);

// Field-level validation
const errors = reactive({
	newPassword: '',
	confirmPassword: '',
});

function validateNewPassword(): boolean {
	if (!newPassword.value) {
		errors.newPassword = 'Password is required';
		return false;
	}
	if (newPassword.value.length < 10) {
		errors.newPassword = 'Password must be at least 10 characters';
		return false;
	}
	errors.newPassword = '';
	return true;
}

function validateConfirmPassword(): boolean {
	if (!confirmPassword.value) {
		errors.confirmPassword = 'Please confirm your password';
		return false;
	}
	if (confirmPassword.value !== newPassword.value) {
		errors.confirmPassword = 'Passwords do not match';
		return false;
	}
	errors.confirmPassword = '';
	return true;
}

function validateForm(): boolean {
	const passwordValid = validateNewPassword();
	const confirmValid = validateConfirmPassword();
	return passwordValid && confirmValid;
}

async function handleSubmit() {
	if (!validateForm()) {
		return;
	}

	await submit(async () => {
		await resetPassword(newPassword.value, token.value);
		isSuccess.value = true;
	}, 'Failed to reset password. The link may have expired.');
}
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex flex-col items-center justify-center px-4">
		<!-- Logo/Brand -->
		<div class="mb-8 text-center">
			<h1 class="font-display text-4xl text-text-primary">Owlat</h1>
			<p class="text-text-secondary mt-2">Set a new password</p>
		</div>

		<UiCard class="w-full max-w-md">
			<!-- No token -->
			<div v-if="!token" class="text-center">
				<h2 class="text-lg font-semibold text-text-primary mb-2">Invalid or missing reset link</h2>
				<p class="text-text-secondary text-sm mb-6">
					This link is invalid or has expired. Please request a new password reset.
				</p>
				<NuxtLink to="/auth/forgot-password" class="link font-medium text-sm">
					Request new reset link
				</NuxtLink>
			</div>

			<!-- Success State -->
			<div v-else-if="isSuccess" class="text-center">
				<div class="mb-4 text-4xl">&#10003;</div>
				<h2 class="text-lg font-semibold text-text-primary mb-2">Password reset successfully</h2>
				<p class="text-text-secondary text-sm mb-6">
					Your password has been updated. You can now sign in with your new password.
				</p>
				<NuxtLink to="/auth/login" class="link font-medium text-sm">
					Sign in
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

				<form class="space-y-5" @submit.prevent="handleSubmit">
					<UiInput
						id="new-password"
						v-model="newPassword"
						type="password"
						autocomplete="new-password"
						label="New password"
						placeholder="Choose a strong password"
						help-text="Must be at least 10 characters"
						:error="errors.newPassword"
						@blur="validateNewPassword"
					/>

					<UiInput
						id="confirm-password"
						v-model="confirmPassword"
						type="password"
						autocomplete="new-password"
						label="Confirm password"
						placeholder="Re-enter your new password"
						:error="errors.confirmPassword"
						@blur="validateConfirmPassword"
					/>

					<UiButton type="submit" size="lg" full-width :loading="isLoading">
						{{ isLoading ? 'Resetting...' : 'Reset password' }}
					</UiButton>
				</form>
			</template>
		</UiCard>
	</div>
</template>
