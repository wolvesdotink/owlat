<script setup lang="ts">
import { api } from '@owlat/api';
import { isValidEmail } from '~/utils/validation';

useHead({ title: 'Sign Up — Owlat' });

definePageMeta({
	middleware: 'guest',
});

const { signUpWithEmail } = useAuth();
const { run: createUserProfile } = useBackendOperation(api.auth.userProfiles.create, {
	label: 'Create profile',
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
		errors.name = 'Name is required';
		return false;
	}
	if (name.value.length < 2) {
		errors.name = 'Name must be at least 2 characters';
		return false;
	}
	errors.name = '';
	return true;
}

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

// Validate terms acceptance
function validateTerms(): boolean {
	if (!termsAccepted.value) {
		errors.terms = 'You must agree to the Terms of Service';
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
	<div class="min-h-screen bg-bg-deep flex flex-col items-center justify-center px-4">
		<!-- Registration blocked — invite-only (unless this is an invite redirect) -->
		<template v-if="!isInviteRedirect">
			<div class="mb-8 text-center">
				<h1 class="font-display text-4xl text-text-primary">Owlat</h1>
				<p class="text-text-secondary mt-2">Invite only</p>
			</div>

			<UiCard class="w-full max-w-md">
				<div class="text-center space-y-4">
					<Icon name="lucide:lock" class="w-12 h-12 text-text-tertiary mx-auto" />
					<p class="text-text-secondary">
						Registration is disabled. Contact your administrator for an invitation.
					</p>
				</div>

				<p class="mt-6 text-center text-text-secondary text-sm">
					Already have an account?
					<NuxtLink to="/auth/login" class="link font-medium"> Sign in </NuxtLink>
				</p>
			</UiCard>
		</template>

		<!-- Registration form (only accessible via invite redirect) -->
		<template v-else>
			<!-- Logo/Brand -->
			<div class="mb-8 text-center">
				<h1 class="font-display text-4xl text-text-primary">Owlat</h1>
				<p class="text-text-secondary mt-2">Create your account</p>
			</div>

			<!-- Register Card -->
			<UiCard class="w-full max-w-md">
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
						label="Name"
						placeholder="Your name"
						:error="errors.name"
						@blur="validateName"
					/>

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
						autocomplete="new-password"
						label="Password"
						placeholder="Choose a strong password"
						:error="errors.password"
						help-text="Must be at least 10 characters"
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
							<span class="text-sm text-text-secondary">
								I agree to the
								<NuxtLink to="/terms" target="_blank" class="link font-medium">Terms of Service</NuxtLink>
							</span>
						</label>
						<p v-if="errors.terms" class="mt-1 text-sm text-error">{{ errors.terms }}</p>
					</div>

					<!-- Submit Button -->
					<UiButton type="submit" size="lg" full-width :loading="isLoading">
						{{ isLoading ? 'Creating account...' : 'Create account' }}
					</UiButton>
				</form>

				<!-- Login Link -->
				<p class="mt-6 text-center text-text-secondary text-sm">
					Already have an account?
					<NuxtLink to="/auth/login" class="link font-medium"> Sign in </NuxtLink>
				</p>
			</UiCard>
		</template>
	</div>
</template>
