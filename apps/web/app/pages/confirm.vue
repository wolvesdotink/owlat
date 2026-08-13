<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('recipient.confirm.pageTitle') });

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
		error.value = t('recipient.confirm.errors.missingToken');
		isLoading.value = false;
		return;
	}

	if (!convex) {
		error.value = t('recipient.confirm.errors.noServer');
		isLoading.value = false;
		return;
	}

	try {
		// Verify the token via Convex query
		const submission = await convex.query(api.forms.endpoints.getByConfirmationToken, {
			token: token.value,
		});

		if (!submission) {
			error.value = t('recipient.confirm.errors.invalid');
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
		error.value = t('recipient.confirm.errors.verifyFailed');
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
				error.value = t('recipient.confirm.errors.invalid');
			} else if (result.error === 'invalid_status') {
				error.value = t('recipient.confirm.errors.alreadyProcessed');
			} else if (result.error === 'token_expired') {
				error.value = t('recipient.confirm.errors.expired');
			} else {
				error.value = t('recipient.confirm.errors.confirmFailed');
			}
			return;
		}

		confirmSuccess.value = true;
		alreadyConfirmed.value = result.alreadyConfirmed || false;
	} catch (err) {
		error.value =
			err instanceof Error ? err.message : t('recipient.confirm.errors.confirmFailed');
	} finally {
		isProcessing.value = false;
	}
}
</script>

<template>
	<!-- Recipient-facing page: opened from an email client, mostly on a phone.
	     Single column, dvh (mobile browser chrome collapses the visual viewport)
	     and safe-area padding so nothing sits under a notch or home indicator. -->
	<div
		class="flex min-h-dvh flex-col items-center justify-center gap-8 bg-bg-deep px-5 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] text-text-primary"
	>
		<!-- Logo/Brand -->
		<header class="text-center">
			<h1 class="font-display text-4xl text-text-primary">Owlat</h1>
			<p class="mt-2 text-text-secondary">{{ t('recipient.confirm.header') }}</p>
		</header>

		<!-- Loading State -->
		<div v-if="isLoading" class="card w-full max-w-md py-8 text-center">
			<div class="flex flex-col items-center gap-4">
				<UiSpinner size="lg" />
				<p class="text-text-secondary">{{ t('recipient.shared.verifying') }}</p>
			</div>
		</div>

		<!-- Error State -->
		<div v-else-if="error" class="card w-full max-w-md">
			<div class="py-2 text-center sm:py-4">
				<div
					class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-subtle sm:h-16 sm:w-16"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-7 w-7 text-error sm:h-8 sm:w-8"
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
				<h2 class="mb-2 text-lg font-semibold text-text-primary">
					{{ t('recipient.confirm.errorHeading') }}
				</h2>
				<p class="text-text-secondary">{{ error }}</p>
			</div>
		</div>

		<!-- Success State -->
		<div v-else-if="confirmSuccess" class="card w-full max-w-md">
			<div class="py-2 text-center sm:py-4">
				<div
					class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success-subtle sm:h-16 sm:w-16"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-7 w-7 text-success sm:h-8 sm:w-8"
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
				<h2 class="mb-2 text-lg font-semibold text-text-primary">
					{{
						alreadyConfirmed
							? t('recipient.confirm.alreadyHeading')
							: t('recipient.confirm.successHeading')
					}}
				</h2>
				<!-- break-words: contact emails and org names are unbounded strings and
				     these cards are read at 320px. -->
				<I18nT
					:keypath="
						alreadyConfirmed ? 'recipient.confirm.alreadyBody' : 'recipient.confirm.successBody'
					"
					tag="p"
					scope="global"
					class="mb-6 break-words text-text-secondary"
				>
					<template #organization><strong>{{ submissionInfo?.organizationName }}</strong></template>
				</I18nT>
				<I18nT
					keypath="recipient.confirm.successNote"
					tag="p"
					scope="global"
					class="text-sm break-words text-text-tertiary"
				>
					<template #email><strong>{{ submissionInfo?.email }}</strong></template>
				</I18nT>
			</div>
		</div>

		<!-- Already Confirmed State (before clicking button) -->
		<div v-else-if="alreadyConfirmed && submissionInfo" class="card w-full max-w-md">
			<div class="py-2 text-center sm:py-4">
				<div
					class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-subtle sm:h-16 sm:w-16"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-7 w-7 text-brand sm:h-8 sm:w-8"
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
				<h2 class="mb-2 text-lg font-semibold text-text-primary">
					{{ t('recipient.confirm.alreadyHeading') }}
				</h2>
				<I18nT
					keypath="recipient.confirm.alreadyStateBody"
					tag="p"
					scope="global"
					class="break-words text-text-secondary"
				>
					<template #organization><strong>{{ submissionInfo.organizationName }}</strong></template>
				</I18nT>
				<I18nT
					keypath="recipient.confirm.alreadyStateNote"
					tag="p"
					scope="global"
					class="mt-4 text-sm break-words text-text-tertiary"
				>
					<template #email><strong>{{ submissionInfo.email }}</strong></template>
				</I18nT>
			</div>
		</div>

		<!-- Confirmation State -->
		<div v-else-if="submissionInfo" class="card w-full max-w-md">
			<div class="py-2 text-center sm:py-4">
				<div
					class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-subtle sm:h-16 sm:w-16"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-7 w-7 text-brand sm:h-8 sm:w-8"
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
				<h2 class="mb-2 text-lg font-semibold text-text-primary">
					{{ t('recipient.confirm.confirmHeading') }}
				</h2>
				<I18nT
					keypath="recipient.confirm.confirmBody"
					tag="p"
					scope="global"
					class="mb-6 break-words text-text-secondary"
				>
					<template #organization><strong>{{ submissionInfo.organizationName }}</strong></template>
					<template #email><strong>{{ submissionInfo.email }}</strong></template>
				</I18nT>

				<!-- h-12: the only action on the page, sized past the 44px touch target. -->
				<UiButton full-width class="h-12" :disabled="isProcessing" @click="handleConfirm">
					<span v-if="isProcessing" class="flex items-center justify-center gap-2">
						<UiSpinner size="sm" tone="inverse" />
						{{ t('recipient.confirm.processing') }}
					</span>
					<span v-else>{{ t('recipient.confirm.submit') }}</span>
				</UiButton>

				<p class="mt-6 text-xs break-words text-text-tertiary">
					{{
						t('recipient.confirm.footnote', { organization: submissionInfo.organizationName })
					}}
				</p>
			</div>
		</div>

		<!-- Footer -->
		<I18nT keypath="common.poweredBy" tag="p" scope="global" class="text-sm text-text-tertiary">
			<template #brand><span class="font-display">Owlat</span></template>
		</I18nT>
	</div>
</template>
