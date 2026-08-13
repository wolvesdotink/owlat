<script setup lang="ts">
const { t } = useI18n();

useHead({ title: () => t('auth.resetPassword.pageTitle') });

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
		errors.newPassword = t('auth.validation.passwordRequired');
		return false;
	}
	if (newPassword.value.length < 10) {
		errors.newPassword = t('auth.validation.passwordTooShort');
		return false;
	}
	errors.newPassword = '';
	return true;
}

function validateConfirmPassword(): boolean {
	if (!confirmPassword.value) {
		errors.confirmPassword = t('auth.validation.confirmPasswordRequired');
		return false;
	}
	if (confirmPassword.value !== newPassword.value) {
		errors.confirmPassword = t('auth.validation.passwordsDoNotMatch');
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
	}, t('auth.resetPassword.failed'));
}
</script>

<template>
	<AuthShell>
		<template #title>
			{{ t('auth.resetPassword.title') }}
			<span class="lp-title-accent">{{ t('auth.resetPassword.titleAccent') }}</span>
		</template>

		<!-- No token -->
		<div v-if="!token" class="text-center">
			<h2 class="text-lg font-semibold text-text-primary mb-2">
				{{ t('auth.resetPassword.invalidHeading') }}
			</h2>
			<p class="text-text-secondary text-sm mb-6">{{ t('auth.resetPassword.invalidBody') }}</p>
			<NuxtLink to="/auth/forgot-password" class="link font-medium text-sm">
				{{ t('auth.resetPassword.requestNewLink') }}
			</NuxtLink>
		</div>

		<!-- Success State -->
		<div v-else-if="isSuccess" class="text-center">
			<div class="mb-4 text-4xl">&#10003;</div>
			<h2 class="text-lg font-semibold text-text-primary mb-2">
				{{ t('auth.resetPassword.successHeading') }}
			</h2>
			<p class="text-text-secondary text-sm mb-6">{{ t('auth.resetPassword.successBody') }}</p>
			<NuxtLink to="/auth/login" class="link font-medium text-sm">
				{{ t('auth.resetPassword.signIn') }}
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
					:label="t('auth.resetPassword.newPasswordLabel')"
					:placeholder="t('auth.fields.strongPasswordPlaceholder')"
					:help-text="t('auth.fields.passwordHelp')"
					:error="errors.newPassword"
					@blur="validateNewPassword"
				/>

				<UiInput
					id="confirm-password"
					v-model="confirmPassword"
					type="password"
					autocomplete="new-password"
					:label="t('auth.resetPassword.confirmPasswordLabel')"
					:placeholder="t('auth.resetPassword.confirmPasswordPlaceholder')"
					:error="errors.confirmPassword"
					@blur="validateConfirmPassword"
				/>

				<UiButton type="submit" size="lg" full-width :loading="isLoading">
					{{ isLoading ? t('auth.resetPassword.submitting') : t('auth.resetPassword.submit') }}
				</UiButton>
			</form>
		</template>
	</AuthShell>
</template>
