<script setup lang="ts">
import { api } from '@owlat/api';
import { isValidEmail } from '@owlat/shared';
import { MIN_PASSWORD_LENGTH, meetsMinPasswordLength } from '@owlat/shared/passwordPolicy';
import { hasPublishedTerms, registrationOpenFor } from '~/utils/instanceEntry';
import { LockIcon, MailIcon } from '@coolicons/vue';

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
const isInviteRedirect = computed(() => registrationOpenFor(route.query['redirect']));

// Form state
const name = ref('');
const email = ref('');
const password = ref('');
const { isLoading, errorMessage, submit } = useAuthForm();
// Set when the account exists but the instance keeps the session back until
// the address is confirmed; the confirmation link carries on from there.
const awaitingConfirmationFor = ref('');

// Field-level validation errors
const termsAccepted = ref(false);
// Only the hosted deployment publishes terms (see `pages/terms.vue`); on a
// self-hosted instance there is nothing to accept, so the checkbox is not asked.
const termsRequired = hasPublishedTerms(useRuntimeConfig().public);

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
	if (!meetsMinPasswordLength(password.value)) {
		errors.password = t('auth.validation.passwordTooShort', { min: MIN_PASSWORD_LENGTH });
		return false;
	}
	errors.password = '';
	return true;
}

// Validate terms acceptance
function validateTerms(): boolean {
	if (termsRequired && !termsAccepted.value) {
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
		const redirect = safeRedirect(route.query['redirect'], '/dashboard');
		// The invitation can only be accepted once the address is confirmed, so
		// the confirmation link leads back to it.
		const result = await signUpWithEmail(email.value, password.value, name.value, {
			callbackURL: redirect,
		});

		// No session yet: the profile mutation needs one, and its refusal would
		// send the person to sign-in instead of telling them to check their inbox.
		if (!result?.token) {
			awaitingConfirmationFor.value = email.value;
			return;
		}

		// Create user profile. Non-blocking: a failure is surfaced by the operation
		// module (toast + telemetry); the user still proceeds to the dashboard.
		if (result.user?.id) {
			await createUserProfile({
				authUserId: result.user.id,
				email: email.value,
				name: name.value,
			});
		}

		await router.push(redirect);
	});
}
</script>

<template>
	<AuthShell v-if="!isInviteRedirect" :subtitle="t('auth.register.inviteOnlyTagline')">
		<template #title>
			{{ t('auth.register.inviteOnlyTitle') }}
			<span class="lp-title-accent">{{ t('auth.register.inviteOnlyTitleAccent') }}</span>
		</template>

		<div class="text-center space-y-4">
			<UiIconBox
				:icon="LockIcon"
				size="xl"
				variant="surface"
				rounded="full"
				class="mx-auto"
				aria-hidden="true"
			/>
			<p class="text-text-secondary">{{ t('auth.register.inviteOnlyBody') }}</p>
		</div>

		<template #footer>
			{{ t('auth.register.haveAccount') }}
			<NuxtLink to="/auth/login" class="link font-medium">
				{{ t('auth.register.signIn') }}
			</NuxtLink>
		</template>
	</AuthShell>

	<AuthShell v-else :subtitle="t('auth.register.tagline')">
		<template #title>
			{{ t('auth.register.title') }}
			<span class="lp-title-accent">{{ t('auth.register.titleAccent') }}</span>
		</template>

		<div v-if="awaitingConfirmationFor" class="text-center space-y-4" role="status">
			<UiIconBox :icon="MailIcon" size="xl" rounded="full" class="mx-auto" aria-hidden="true" />
			<h2 class="text-lg font-semibold text-text-primary">
				{{ t('auth.register.checkInboxTitle') }}
			</h2>
			<I18nT
				keypath="auth.register.checkInboxBody"
				tag="p"
				scope="global"
				class="text-text-secondary"
			>
				<template #email>
					<strong class="text-text-primary">{{ awaitingConfirmationFor }}</strong>
				</template>
			</I18nT>
		</div>

		<!-- Error Message: announced, since focus stays on the submit button. -->
		<UiErrorAlert v-else-if="errorMessage" :message="errorMessage" role="alert" class="mb-6" />

		<form v-if="!awaitingConfirmationFor" class="space-y-5" @submit.prevent="handleSubmit">
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
			<AuthPasswordInput
				id="password"
				v-model="password"
				autocomplete="new-password"
				:label="t('auth.fields.password')"
				:placeholder="t('auth.fields.strongPasswordPlaceholder')"
				:error="errors.password"
				:help-text="t('auth.fields.passwordHelp', { min: MIN_PASSWORD_LENGTH })"
				@blur="validatePassword"
			/>

			<!-- Terms Checkbox. Native rather than UiCheckbox: its label carries a link. -->
			<div v-if="termsRequired">
				<label for="register-terms" class="flex items-start gap-2 cursor-pointer">
					<input
						id="register-terms"
						v-model="termsAccepted"
						type="checkbox"
						class="mt-1 h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus:ring-brand"
						:aria-invalid="errors.terms ? 'true' : undefined"
						:aria-describedby="errors.terms ? 'register-terms-error' : undefined"
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
				<p v-if="errors.terms" id="register-terms-error" class="mt-1 text-sm text-error">
					{{ errors.terms }}
				</p>
			</div>

			<!-- Submit Button -->
			<UiButton type="submit" size="lg" full-width :loading="isLoading">
				{{ isLoading ? t('auth.register.submitting') : t('auth.register.submit') }}
			</UiButton>
		</form>

		<template #footer>
			<p>
				{{ t('auth.register.haveAccount') }}
				<NuxtLink to="/auth/login" class="link font-medium">
					{{ t('auth.register.signIn') }}
				</NuxtLink>
			</p>
			<AuthLegalFooter />
		</template>
	</AuthShell>
</template>
