<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Confirm Submission \u2014 Owlat' });

// Public confirmation page - no auth middleware needed
definePageMeta({
	layout: false, // No dashboard layout, standalone page
});

const route = useRoute();
const convex = useConvex();

// State
const isLoading = ref(true);
const isProcessing = ref(false);
const error = ref<string | null>(null);
const submissionInfo = ref<{
	email: string;
	organizationName: string;
	status: string;
	confirmedAt?: number;
} | null>(null);
const confirmSuccess = ref(false);
const alreadyConfirmed = ref(false);

// Get the token from the URL
const token = computed(() => route.query['token'] as string | undefined);

// Verify the token on mount
onMounted(async () => {
	if (!token.value) {
		error.value = 'Missing confirmation token. Please use the link from your email.';
		isLoading.value = false;
		return;
	}

	if (!convex) {
		error.value = 'Unable to connect to the server. Please try again later.';
		isLoading.value = false;
		return;
	}

	try {
		// Verify the token via Convex query
		const submission = await convex.query(api.forms.endpoints.getByConfirmationToken, {
			token: token.value,
		});

		if (!submission) {
			error.value = 'Invalid confirmation link. Please use the link from your email.';
			isLoading.value = false;
			return;
		}

		submissionInfo.value = {
			email: submission.email,
			organizationName: submission.organizationName,
			status: submission.status,
			confirmedAt: submission.confirmedAt,
		};

		// Check if already confirmed
		if (submission.status === 'success' && submission.confirmedAt) {
			alreadyConfirmed.value = true;
		}
	} catch (err) {
		error.value = 'Unable to verify your confirmation link. Please try again later.';
	} finally {
		isLoading.value = false;
	}
});

// Handle subscription confirmation
async function handleConfirm() {
	if (!token.value || !convex) return;

	isProcessing.value = true;
	error.value = null;

	try {
		// Call the confirmation mutation
		const result = await convex.mutation(api.forms.endpoints.confirmSubmission, {
			token: token.value,
		});

		if (!result.success) {
			if (result.error === 'invalid_token') {
				error.value = 'Invalid confirmation link. Please use the link from your email.';
			} else if (result.error === 'invalid_status') {
				error.value = 'This subscription has already been processed.';
			} else if (result.error === 'token_expired') {
				error.value = 'This confirmation link has expired. Please request a new one.';
			} else {
				error.value = 'Failed to confirm subscription. Please try again.';
			}
			return;
		}

		confirmSuccess.value = true;
		alreadyConfirmed.value = result.alreadyConfirmed || false;
	} catch (err) {
		error.value =
			err instanceof Error ? err.message : 'Failed to confirm subscription. Please try again.';
	} finally {
		isProcessing.value = false;
	}
}
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex flex-col items-center justify-center px-4">
		<!-- Logo/Brand -->
		<div class="mb-8 text-center">
			<h1 class="font-display text-4xl text-text-primary">Owlat</h1>
			<p class="text-text-secondary mt-2">Email Confirmation</p>
		</div>

		<!-- Loading State -->
		<div v-if="isLoading" class="card w-full max-w-md text-center py-12">
			<div class="flex flex-col items-center gap-4">
				<svg
					class="animate-spin h-8 w-8 text-brand"
					xmlns="http://www.w3.org/2000/svg"
					fill="none"
					viewBox="0 0 24 24"
				>
					<circle
						class="opacity-25"
						cx="12"
						cy="12"
						r="10"
						stroke="currentColor"
						stroke-width="4"
					/>
					<path
						class="opacity-75"
						fill="currentColor"
						d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
					/>
				</svg>
				<p class="text-text-secondary">Verifying your link...</p>
			</div>
		</div>

		<!-- Error State -->
		<div v-else-if="error" class="card w-full max-w-md">
			<div class="text-center py-8">
				<div
					class="w-16 h-16 mx-auto mb-4 rounded-full bg-error-subtle flex items-center justify-center"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-8 w-8 text-error"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
						/>
					</svg>
				</div>
				<h2 class="text-lg font-semibold text-text-primary mb-2">Unable to Confirm</h2>
				<p class="text-text-secondary">{{ error }}</p>
			</div>
		</div>

		<!-- Success State -->
		<div v-else-if="confirmSuccess" class="card w-full max-w-md">
			<div class="text-center py-8">
				<div
					class="w-16 h-16 mx-auto mb-4 rounded-full bg-success-subtle flex items-center justify-center"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-8 w-8 text-success"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M5 13l4 4L19 7"
						/>
					</svg>
				</div>
				<h2 class="text-lg font-semibold text-text-primary mb-2">
					{{ alreadyConfirmed ? 'Already Confirmed' : 'Subscription Confirmed!' }}
				</h2>
				<p class="text-text-secondary mb-6">
					<template v-if="alreadyConfirmed">
						Your subscription to <strong>{{ submissionInfo?.organizationName }}</strong> was already
						confirmed.
					</template>
					<template v-else>
						You have successfully confirmed your subscription to
						<strong>{{ submissionInfo?.organizationName }}</strong
						>.
					</template>
				</p>
				<p class="text-text-tertiary text-sm">
					<strong>{{ submissionInfo?.email }}</strong> is now subscribed and will receive updates.
				</p>
			</div>
		</div>

		<!-- Already Confirmed State (before clicking button) -->
		<div v-else-if="alreadyConfirmed && submissionInfo" class="card w-full max-w-md">
			<div class="text-center py-8">
				<div
					class="w-16 h-16 mx-auto mb-4 rounded-full bg-brand-subtle flex items-center justify-center"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-8 w-8 text-brand"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M5 13l4 4L19 7"
						/>
					</svg>
				</div>
				<h2 class="text-lg font-semibold text-text-primary mb-2">Already Confirmed</h2>
				<p class="text-text-secondary">
					Your subscription to <strong>{{ submissionInfo.organizationName }}</strong> has already
					been confirmed.
				</p>
				<p class="text-text-tertiary text-sm mt-4">
					<strong>{{ submissionInfo.email }}</strong> is subscribed and will receive updates.
				</p>
			</div>
		</div>

		<!-- Confirmation State -->
		<div v-else-if="submissionInfo" class="card w-full max-w-md">
			<div class="text-center py-8">
				<div
					class="w-16 h-16 mx-auto mb-4 rounded-full bg-brand-subtle flex items-center justify-center"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-8 w-8 text-brand"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
						/>
					</svg>
				</div>
				<h2 class="text-lg font-semibold text-text-primary mb-2">Confirm Your Subscription</h2>
				<p class="text-text-secondary mb-6">
					Click the button below to confirm your subscription to
					<strong>{{ submissionInfo.organizationName }}</strong> with the email address
					<strong>{{ submissionInfo.email }}</strong
					>.
				</p>

				<div class="space-y-3">
					<button
						class="btn btn-primary w-full h-12"
						:disabled="isProcessing"
						@click="handleConfirm"
					>
						<span v-if="isProcessing" class="flex items-center justify-center gap-2">
							<svg
								class="animate-spin h-5 w-5"
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								viewBox="0 0 24 24"
							>
								<circle
									class="opacity-25"
									cx="12"
									cy="12"
									r="10"
									stroke="currentColor"
									stroke-width="4"
								/>
								<path
									class="opacity-75"
									fill="currentColor"
									d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
								/>
							</svg>
							Confirming...
						</span>
						<span v-else>Confirm Subscription</span>
					</button>
				</div>

				<p class="text-text-tertiary text-xs mt-6">
					By confirming, you agree to receive emails from {{ submissionInfo.organizationName }}.
				</p>
			</div>
		</div>

		<!-- Footer -->
		<p class="mt-8 text-text-tertiary text-sm">
			Powered by <span class="font-display">Owlat</span>
		</p>
	</div>
</template>
