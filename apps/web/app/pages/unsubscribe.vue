<script setup lang="ts">
useSeoMeta({
	title: 'Unsubscribe \u2014 Owlat',
	description: 'Manage your email subscription preferences.',
	ogTitle: 'Unsubscribe \u2014 Owlat',
});

// Public unsubscribe page - no auth middleware needed
definePageMeta({
	layout: false, // No dashboard layout, standalone page
});

const route = useRoute();
const config = useRuntimeConfig();

// State
const isLoading = ref(true);
const isProcessing = ref(false);
const error = ref<string | null>(null);
const contactInfo = ref<{
	email: string;
	firstName?: string;
	subscribed: boolean;
	teamName: string;
} | null>(null);
const unsubscribeSuccess = ref(false);
const alreadyUnsubscribed = ref(false);

// Get the token from the URL
const token = computed(() => route.query['token'] as string | undefined);

// Verify the token on mount
onMounted(async () => {
	if (!token.value) {
		error.value = 'Missing unsubscribe token. Please use the link from your email.';
		isLoading.value = false;
		return;
	}

	try {
		// Verify the token via the Convex HTTP endpoint (outcome mode: 200 either way)
		const verifyUrl = `${config.public.convexSiteUrl}/unsub/verify/${encodeURIComponent(token.value)}`;
		const response = await fetch(verifyUrl);
		const body = await response.json();

		if (!body.ok) {
			if (body.reason === 'expired') {
				error.value =
					'This unsubscribe link has expired. Please use a more recent email to unsubscribe.';
			} else {
				error.value = 'Invalid unsubscribe link. Please use the link from your email.';
			}
			isLoading.value = false;
			return;
		}

		const { data } = body;
		contactInfo.value = {
			email: data.email,
			firstName: data.firstName,
			subscribed: data.subscribed,
			teamName: data.organizationName,
		};

		// Check if already unsubscribed
		if (!data.subscribed) {
			alreadyUnsubscribed.value = true;
		}
	} catch (err) {
		error.value = 'Unable to verify your unsubscribe link. Please try again later.';
	} finally {
		isLoading.value = false;
	}
});

// Handle unsubscribe confirmation
async function handleUnsubscribe() {
	if (!token.value) return;

	isProcessing.value = true;
	error.value = null;

	try {
		// Call the one-click unsubscribe endpoint (action mode)
		const unsubscribeUrl = `${config.public.convexSiteUrl}/unsub/${encodeURIComponent(token.value)}`;
		const response = await fetch(unsubscribeUrl, {
			method: 'POST',
		});
		const body = await response.json();

		if (!response.ok || !body.ok) {
			throw new Error(body.error?.message || 'Failed to unsubscribe');
		}

		unsubscribeSuccess.value = true;
		if (body.data?.message?.includes('already')) {
			alreadyUnsubscribed.value = true;
		}
	} catch (err) {
		error.value =
			err instanceof Error
				? err.message
				: 'Failed to process unsubscribe request. Please try again.';
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
			<p class="text-text-secondary mt-2">Email Preferences</p>
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
				<h2 class="text-lg font-semibold text-text-primary mb-2">Unable to Unsubscribe</h2>
				<p class="text-text-secondary">{{ error }}</p>
			</div>
		</div>

		<!-- Success State -->
		<div v-else-if="unsubscribeSuccess" class="card w-full max-w-md">
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
					{{ alreadyUnsubscribed ? 'Already Unsubscribed' : 'Successfully Unsubscribed' }}
				</h2>
				<p class="text-text-secondary mb-6">
					<template v-if="alreadyUnsubscribed">
						You were already unsubscribed from emails from
						<strong>{{ contactInfo?.teamName }}</strong
						>.
					</template>
					<template v-else>
						You have been unsubscribed from emails from <strong>{{ contactInfo?.teamName }}</strong
						>.
					</template>
				</p>
				<p class="text-text-tertiary text-sm">
					You will no longer receive marketing emails at <strong>{{ contactInfo?.email }}</strong
					>.
				</p>
			</div>
		</div>

		<!-- Already Unsubscribed State (before clicking button) -->
		<div v-else-if="alreadyUnsubscribed && contactInfo" class="card w-full max-w-md">
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
				<h2 class="text-lg font-semibold text-text-primary mb-2">Already Unsubscribed</h2>
				<p class="text-text-secondary">
					You are already unsubscribed from emails from <strong>{{ contactInfo.teamName }}</strong
					>.
				</p>
				<p class="text-text-tertiary text-sm mt-4">
					No marketing emails will be sent to <strong>{{ contactInfo.email }}</strong
					>.
				</p>
			</div>
		</div>

		<!-- Confirmation State -->
		<div v-else-if="contactInfo" class="card w-full max-w-md">
			<div class="text-center py-8">
				<div
					class="w-16 h-16 mx-auto mb-4 rounded-full bg-bg-elevated flex items-center justify-center"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-8 w-8 text-text-secondary"
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
				<h2 class="text-lg font-semibold text-text-primary mb-2">Unsubscribe from Emails</h2>
				<p class="text-text-secondary mb-6">
					<template v-if="contactInfo.firstName"> Hi {{ contactInfo.firstName }}, </template>
					Are you sure you want to unsubscribe <strong>{{ contactInfo.email }}</strong> from emails
					sent by <strong>{{ contactInfo.teamName }}</strong
					>?
				</p>

				<div class="space-y-3">
					<button
						class="btn btn-primary w-full h-12"
						:disabled="isProcessing"
						@click="handleUnsubscribe"
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
							Processing...
						</span>
						<span v-else>Yes, Unsubscribe Me</span>
					</button>
				</div>

				<p class="text-text-tertiary text-xs mt-6">
					You will stop receiving marketing emails. Transactional emails may still be sent.
				</p>
			</div>
		</div>

		<!-- Footer -->
		<p class="mt-8 text-text-tertiary text-sm">
			Powered by <span class="font-display">Owlat</span>
		</p>
	</div>
</template>
