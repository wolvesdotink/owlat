<script setup lang="ts">
import { api } from '@owlat/api';
import { useUrlCredential } from '~/composables/useUrlCredential';
import { ArrowRightIcon, CheckIcon, CircleWarningIcon } from '@coolicons/vue';

const { t } = useI18n();

useHead({ title: () => t('cancelDeletion.pageTitle') });

// The cancellation token from the URL (taken out of the address bar once read)
const { token, forget: forgetToken } = useUrlCredential('token');

// State
const status = ref<'loading' | 'success' | 'error' | 'no-token'>('loading');
// Bound as the operation's inline target so the categorized failure message lands
// here (and is shown in the error card) instead of only firing a toast.
const errorMessage = ref<string | null>('');

// On a self-hosted instance `/` is the sign-in page, so "Go home" next to
// "Sign in" would be the same link twice.
const showGoHome = useRuntimeConfig().public.deploymentMode === 'hosted';

// Cancel deletion mutation
const { run: cancelDeletion } = useBackendOperation(
	api.auth.accountManagement.cancelAccountDeletion,
	{ label: () => t('cancelDeletion.operationLabel'), inlineTarget: errorMessage }
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
	if (!result.ok) {
		// The operation module populated `errorMessage` (inlineTarget) with the
		// categorized failure; reflect the failure in the page state machine.
		status.value = 'error';
		return;
	}
	forgetToken();
	status.value = 'success';
});
</script>

<template>
	<div class="min-h-dvh flex items-center justify-center p-6 bg-bg-deep">
		<div class="w-full max-w-md">
			<!-- Loading State -->
			<div v-if="status === 'loading'" class="card p-8 text-center" role="status">
				<div class="flex justify-center mb-4" aria-hidden="true">
					<UiSpinner size="xl" />
				</div>
				<h1 class="text-xl font-semibold text-text-primary mb-2">
					{{ t('cancelDeletion.loadingTitle') }}
				</h1>
				<p class="text-text-secondary text-sm">{{ t('cancelDeletion.loadingBody') }}</p>
			</div>

			<!-- Success State -->
			<div v-else-if="status === 'success'" class="card p-8 text-center">
				<UiIconBox
					:icon="CheckIcon"
					size="xl"
					variant="success"
					rounded="full"
					class="mx-auto mb-4"
					aria-hidden="true"
				/>
				<h1 class="text-xl font-semibold text-text-primary mb-2">
					{{ t('cancelDeletion.successTitle') }}
				</h1>
				<p class="text-text-secondary text-sm mb-6">
					{{ t('cancelDeletion.successBody') }}
				</p>
				<UiButton to="/dashboard">
					{{ t('cancelDeletion.goToDashboard') }}
					<template #iconRight><ArrowRightIcon class="w-4 h-4 ml-2" /></template>
				</UiButton>
			</div>

			<!-- Error State -->
			<div v-else-if="status === 'error'" class="card p-8 text-center">
				<UiIconBox
					:icon="CircleWarningIcon"
					size="xl"
					variant="error"
					rounded="full"
					class="mx-auto mb-4"
					aria-hidden="true"
				/>
				<h1 class="text-xl font-semibold text-text-primary mb-2">
					{{ t('cancelDeletion.errorTitle') }}
				</h1>
				<p class="text-text-secondary text-sm mb-4">
					{{ errorMessage || t('cancelDeletion.errorBody') }}
				</p>
				<p class="text-text-tertiary text-xs mb-6">
					{{ t('cancelDeletion.errorHint') }}
				</p>
				<div class="flex gap-3 justify-center">
					<UiButton variant="secondary" to="/auth/login">{{ t('cancelDeletion.signIn') }}</UiButton>
					<UiButton v-if="showGoHome" variant="ghost" to="/">{{
						t('cancelDeletion.goHome')
					}}</UiButton>
				</div>
			</div>

			<!-- No Token State -->
			<div v-else-if="status === 'no-token'" class="card p-8 text-center">
				<UiIconBox
					:icon="CircleWarningIcon"
					size="xl"
					variant="warning"
					rounded="full"
					class="mx-auto mb-4"
					aria-hidden="true"
				/>
				<h1 class="text-xl font-semibold text-text-primary mb-2">
					{{ t('cancelDeletion.noTokenTitle') }}
				</h1>
				<p class="text-text-secondary text-sm mb-6">
					{{ t('cancelDeletion.noTokenBody') }}
				</p>
				<div class="flex gap-3 justify-center">
					<UiButton to="/auth/login">{{ t('cancelDeletion.signIn') }}</UiButton>
					<UiButton v-if="showGoHome" variant="ghost" to="/">{{
						t('cancelDeletion.goHome')
					}}</UiButton>
				</div>
			</div>
		</div>
	</div>
</template>
