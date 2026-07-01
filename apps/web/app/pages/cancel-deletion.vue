<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Cancel Deletion \u2014 Owlat' });

// Get the cancellation token from the URL
const route = useRoute();
const token = computed(() => route.query['token'] as string | undefined);

// State
const status = ref<'loading' | 'success' | 'error' | 'no-token'>('loading');
// Bound as the operation's inline target so the categorized failure message lands
// here (and is shown in the error card) instead of only firing a toast.
const errorMessage = ref<string | null>('');

// Cancel deletion mutation
const { run: cancelDeletion } = useBackendOperation(
	api.auth.accountManagement.cancelAccountDeletion,
	{ label: 'Cancel account deletion', inlineTarget: errorMessage }
);

// Process the cancellation
onMounted(async () => {
	if (!token.value) {
		status.value = 'no-token';
		return;
	}

	const result = await cancelDeletion({
		userId: '', // Empty string - will use token-based lookup
		cancellationToken: token.value,
	});
	if (result === undefined) {
		// The operation module populated `errorMessage` (inlineTarget) with the
		// categorized failure; reflect the failure in the page state machine.
		status.value = 'error';
		return;
	}
	status.value = 'success';
});
</script>

<template>
	<div class="min-h-screen flex items-center justify-center p-6 bg-bg-deep">
		<div class="w-full max-w-md">
			<!-- Loading State -->
			<div v-if="status === 'loading'" class="card p-8 text-center">
				<div class="flex justify-center mb-4">
					<UiSpinner size="xl" />
				</div>
				<h1 class="text-xl font-semibold text-text-primary mb-2">Cancelling Deletion...</h1>
				<p class="text-text-secondary text-sm">Please wait while we process your request.</p>
			</div>

			<!-- Success State -->
			<div v-else-if="status === 'success'" class="card p-8 text-center">
				<div class="flex justify-center mb-4">
					<div class="p-4 rounded-full bg-success/10">
						<Icon name="lucide:check" class="w-8 h-8 text-success" />
					</div>
				</div>
				<h1 class="text-xl font-semibold text-text-primary mb-2">Deletion Cancelled</h1>
				<p class="text-text-secondary text-sm mb-6">
					Your account deletion has been cancelled. Your account and all data will be preserved.
				</p>
				<NuxtLink to="/dashboard" class="btn btn-primary gap-2 inline-flex">
					Go to Dashboard
					<Icon name="lucide:arrow-right" class="w-4 h-4" />
				</NuxtLink>
			</div>

			<!-- Error State -->
			<div v-else-if="status === 'error'" class="card p-8 text-center">
				<div class="flex justify-center mb-4">
					<div class="p-4 rounded-full bg-error/10">
						<Icon name="lucide:alert-circle" class="w-8 h-8 text-error" />
					</div>
				</div>
				<h1 class="text-xl font-semibold text-text-primary mb-2">Cancellation Failed</h1>
				<p class="text-text-secondary text-sm mb-4">
					{{ errorMessage || "We couldn't process your cancellation request." }}
				</p>
				<p class="text-text-tertiary text-xs mb-6">
					The link may have expired or the deletion may have already been cancelled. If you believe
					this is an error, please contact support.
				</p>
				<div class="flex gap-3 justify-center">
					<NuxtLink to="/auth/login" class="btn btn-secondary"> Sign In </NuxtLink>
					<NuxtLink to="/" class="btn btn-ghost"> Go Home </NuxtLink>
				</div>
			</div>

			<!-- No Token State -->
			<div v-else-if="status === 'no-token'" class="card p-8 text-center">
				<div class="flex justify-center mb-4">
					<div class="p-4 rounded-full bg-warning/10">
						<Icon name="lucide:x-circle" class="w-8 h-8 text-warning" />
					</div>
				</div>
				<h1 class="text-xl font-semibold text-text-primary mb-2">Invalid Link</h1>
				<p class="text-text-secondary text-sm mb-6">
					This cancellation link is invalid or missing the required token. Please use the link from
					your email or sign in to manage your account.
				</p>
				<div class="flex gap-3 justify-center">
					<NuxtLink to="/auth/login" class="btn btn-primary"> Sign In </NuxtLink>
					<NuxtLink to="/" class="btn btn-ghost"> Go Home </NuxtLink>
				</div>
			</div>
		</div>
	</div>
</template>
