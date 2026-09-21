<script setup lang="ts">
import { api } from '@owlat/api';
import { isValidEmail } from '@owlat/shared';

const { t } = useI18n();

useHead({ title: () => t('auth.register.pageTitle') });

definePageMeta({
	middleware: 'guest',
});

const { signUpWithEmail } = useAuth();
const { run: createUserProfile } = useBackendOperation(api.auth.userProfiles.create, {
	label: () => t('auth.register.createProfileOperation'),
});
const router = useRouter();
const route = useRoute();

// Allow registration only for invited users (redirect to /invite/accept)
const isInviteRedirect = computed(() => {
	const redirect = route.query['redirect'] as string | undefined;
	return redirect ? decodeURIComponent(redirect).startsWith('/invite/accept') : false;
});

// Form state
const name = ref('');
const email = ref('');
const password = ref('');
const { isLoading, errorMessage, submit } = useAuthForm();

// Field-level validation errors
const termsAccepted = ref(false);

const errors = reactive({
	name: '',
	email: '',
	password: '',
	terms: '',
});

// Validate name
function validateName(): boolean {
	if (!name.value) {
		errors.name = t('auth.validation.nameRequired');
		return false;
	}
	if (name.value.length < 2) {
		errors.name = t('auth.validation.nameTooShort');
		return false;
	}
	errors.name = '';
	return true;
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

// Validate terms acceptance
function validateTerms(): boolean {
	if (!termsAccepted.value) {
		errors.terms = t('auth.validation.termsRequired');
		return false;
	}
	errors.terms = '';
	return true;
}

// Validate all fields
function validateForm(): boolean {
	const nameValid = validateName();
	const emailValid = validateEmail();
	const passwordValid = validatePassword();
	const termsValid = validateTerms();
	return nameValid && emailValid && passwordValid && termsValid;
}

// Handle form submission
async function handleSubmit() {
	if (!validateForm()) {
		return;
	}

	await submit(async () => {
		const result = await signUpWithEmail(email.value, password.value, name.value);

		// Create user profile. Non-blocking: a failure is surfaced by the operation
		// module (toast + telemetry); the user still proceeds to the dashboard.
		if (result?.user?.id) {
			await createUserProfile({
				authUserId: result.user.id,
				email: email.value,
				name: name.value,
			});
		}

		// Redirect to the invite accept page or dashboard
		const redirect = route.query['redirect'] as string | undefined;
		await router.push(redirect || '/dashboard');
	});
}
</script>

<template>
	<!-- Registration blocked — invite-only (unless this is an invite redirect) -->
	<AuthShell v-if="!isInviteRedirect" :subtitle="t('auth.register.inviteOnlyTagline')">
		<template #title>
			{{ t('auth.register.inviteOnlyTitle') }}
			<span class="lp-title-accent">{{ t('auth.register.inviteOnlyTitleAccent') }}</span>
		</template>

		<div class="text-center space-y-4">
			<Icon name="lucide:lock" class="w-12 h-12 text-text-tertiary mx-auto" />
			<p class="text-text-secondary">{{ t('auth.register.inviteOnlyBody') }}</p>
		</div>

		<template #footer>
			{{ t('auth.register.haveAccount') }}
			<NuxtLink to="/auth/login" class="link font-medium">
				{{ t('auth.register.signIn') }}
			</NuxtLink>
		</template>
	</AuthShell>

	<!-- Registration form (only accessible via invite redirect) -->
	<AuthShell v-else :subtitle="t('auth.register.tagline')">
		<template #title>
			{{ t('auth.register.title') }}
			<span class="lp-title-accent">{{ t('auth.register.titleAccent') }}</span>
		</template>

		<!-- Error Message -->
		<div
			v-if="errorMessage"
			class="mb-6 p-4 bg-error-subtle border border-error/30 rounded-lg text-error text-sm"
		>
			{{ errorMessage }}
		</div>

		<form class="space-y-5" @submit.prevent="handleSubmit">
			<!-- Name Field -->
			<UiInput
				id="name"
				v-model="name"
				type="text"
				autocomplete="name"
				:label="t('auth.register.nameLabel')"
				:placeholder="t('auth.register.namePlaceholder')"
				:error="errors.name"
				@blur="validateName"
			/>

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
				autocomplete="new-password"
				:label="t('auth.fields.password')"
				:placeholder="t('auth.fields.strongPasswordPlaceholder')"
				:error="errors.password"
				:help-text="t('auth.fields.passwordHelp')"
				@blur="validatePassword"
			/>

			<!-- Terms Checkbox -->
			<div>
				<label class="flex items-start gap-2 cursor-pointer">
					<input
						v-model="termsAccepted"
						type="checkbox"
						class="mt-1 h-4 w-4 rounded border-border-primary text-brand focus:ring-brand"
						@change="errors.terms = ''"
					/>
					<I18nT
						keypath="auth.register.terms"
						tag="span"
						scope="global"
						class="text-sm text-text-secondary"
					>
						<template #termsLink>
							<NuxtLink to="/terms" target="_blank" class="link font-medium">
								{{ t('auth.register.termsLink') }}
							</NuxtLink>
						</template>
					</I18nT>
				</label>
				<p v-if="errors.terms" class="mt-1 text-sm text-error">{{ errors.terms }}</p>
			</div>

			<!-- Submit Button -->
			<UiButton type="submit" size="lg" full-width :loading="isLoading">
				{{ isLoading ? t('auth.register.submitting') : t('auth.register.submit') }}
			</UiButton>
		</form>

		<template #footer>
			{{ t('auth.register.haveAccount') }}
			<NuxtLink to="/auth/login" class="link font-medium">
				{{ t('auth.register.signIn') }}
			</NuxtLink>
		</template>
	</AuthShell>
</template>
