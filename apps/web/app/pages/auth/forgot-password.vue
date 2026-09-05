<script setup lang="ts">
import { isValidEmail } from '@owlat/shared';

const { t } = useI18n();

useHead({ title: () => t('auth.forgotPassword.pageTitle') });

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
		emailError.value = t('auth.validation.emailRequired');
		return false;
	}
	if (!isValidEmail(email.value)) {
		emailError.value = t('auth.validation.emailInvalid');
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
	<AuthShell>
		<template #title>
			{{ t('auth.forgotPassword.title') }}
			<span class="lp-title-accent">{{ t('auth.forgotPassword.titleAccent') }}</span>
		</template>

		<!-- Success State -->
		<div v-if="isSuccess" class="text-center">
			<div class="mb-4 text-4xl">&#9993;</div>
			<h2 class="text-lg font-semibold text-text-primary mb-2">
				{{ t('auth.forgotPassword.successHeading') }}
			</h2>
			<I18nT
				keypath="auth.forgotPassword.successBody"
				tag="p"
				scope="global"
				class="text-text-secondary text-sm mb-6"
			>
				<template #email
					><strong class="text-text-primary">{{ email }}</strong></template
				>
			</I18nT>
			<NuxtLink to="/auth/login" class="link font-medium text-sm">
				{{ t('auth.forgotPassword.backToLogin') }}
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

			<p class="text-text-secondary text-sm mb-6">{{ t('auth.forgotPassword.intro') }}</p>

			<form class="space-y-5" @submit.prevent="handleSubmit">
				<UiInput
					id="email"
					v-model="email"
					type="email"
					autocomplete="email"
					:label="t('auth.fields.email')"
					:placeholder="t('auth.fields.emailPlaceholder')"
					:error="emailError"
					@blur="validateEmail"
				/>

				<UiButton type="submit" size="lg" full-width :loading="isLoading">
					{{ isLoading ? t('auth.forgotPassword.submitting') : t('auth.forgotPassword.submit') }}
				</UiButton>
			</form>

			<p class="mt-6 text-center text-text-secondary text-sm">
				<NuxtLink to="/auth/login" class="link font-medium">{{
					t('auth.forgotPassword.backToLogin')
				}}</NuxtLink>
			</p>
		</template>
	</AuthShell>
</template>
