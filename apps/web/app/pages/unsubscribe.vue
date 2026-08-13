<script setup lang="ts">
const { t } = useI18n();

useSeoMeta({
	title: () => t('recipient.unsubscribe.pageTitle'),
	description: () => t('recipient.unsubscribe.metaDescription'),
	ogTitle: () => t('recipient.unsubscribe.pageTitle'),
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
		error.value = t('recipient.unsubscribe.errors.missingToken');
		isLoading.value = false;
		return;
	}

	try {
		// Verify the token via the Convex HTTP endpoint (outcome mode: 200 either way)
		const verifyUrl = `${config.public.convexSiteUrl}/unsub/verify/${encodeURIComponent(token.value)}`;
		const response = await fetch(verifyUrl);
		const body = await response.json();

		if (!body.ok) {
			error.value =
				body.reason === 'expired'
					? t('recipient.unsubscribe.errors.expired')
					: t('recipient.unsubscribe.errors.invalid');
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
		error.value = t('recipient.unsubscribe.errors.verifyFailed');
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
			err instanceof Error ? err.message : t('recipient.unsubscribe.errors.processFailed');
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
			<p class="mt-2 text-text-secondary">{{ t('recipient.shared.emailPreferences') }}</p>
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
					{{ t('recipient.unsubscribe.errorHeading') }}
				</h2>
				<p class="text-text-secondary">{{ error }}</p>
			</div>
		</div>

		<!-- Success State -->
		<div v-else-if="unsubscribeSuccess" class="card w-full max-w-md">
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
						alreadyUnsubscribed
							? t('recipient.unsubscribe.alreadyHeading')
							: t('recipient.unsubscribe.successHeading')
					}}
				</h2>
				<!-- break-words: contact emails and org names are unbounded strings and
				     these cards are read at 320px. -->
				<I18nT
					:keypath="
						alreadyUnsubscribed
							? 'recipient.unsubscribe.alreadyBody'
							: 'recipient.unsubscribe.successBody'
					"
					tag="p"
					scope="global"
					class="mb-6 break-words text-text-secondary"
				>
					<template #organization><strong>{{ contactInfo?.teamName }}</strong></template>
				</I18nT>
				<I18nT
					keypath="recipient.unsubscribe.successNote"
					tag="p"
					scope="global"
					class="text-sm break-words text-text-tertiary"
				>
					<template #email><strong>{{ contactInfo?.email }}</strong></template>
				</I18nT>
			</div>
		</div>

		<!-- Already Unsubscribed State (before clicking button) -->
		<div v-else-if="alreadyUnsubscribed && contactInfo" class="card w-full max-w-md">
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
					{{ t('recipient.unsubscribe.alreadyHeading') }}
				</h2>
				<I18nT
					keypath="recipient.unsubscribe.alreadyStateBody"
					tag="p"
					scope="global"
					class="break-words text-text-secondary"
				>
					<template #organization><strong>{{ contactInfo.teamName }}</strong></template>
				</I18nT>
				<I18nT
					keypath="recipient.unsubscribe.alreadyStateNote"
					tag="p"
					scope="global"
					class="mt-4 text-sm break-words text-text-tertiary"
				>
					<template #email><strong>{{ contactInfo.email }}</strong></template>
				</I18nT>
			</div>
		</div>

		<!-- Confirmation State -->
		<div v-else-if="contactInfo" class="card w-full max-w-md">
			<div class="py-2 text-center sm:py-4">
				<div
					class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-bg-surface sm:h-16 sm:w-16"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-7 w-7 text-text-secondary sm:h-8 sm:w-8"
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
					{{ t('recipient.unsubscribe.confirmHeading') }}
				</h2>
				<p class="mb-6 break-words text-text-secondary">
					<template v-if="contactInfo.firstName">
						{{ t('recipient.unsubscribe.greeting', { name: contactInfo.firstName }) }}
					</template>
					<I18nT keypath="recipient.unsubscribe.confirmBody" tag="span" scope="global">
						<template #email><strong>{{ contactInfo.email }}</strong></template>
						<template #organization><strong>{{ contactInfo.teamName }}</strong></template>
					</I18nT>
				</p>

				<!-- h-12: the only action on the page, sized past the 44px touch target. -->
				<UiButton full-width class="h-12" :disabled="isProcessing" @click="handleUnsubscribe">
					<span v-if="isProcessing" class="flex items-center justify-center gap-2">
						<UiSpinner size="sm" tone="inverse" />
						{{ t('recipient.unsubscribe.processing') }}
					</span>
					<span v-else>{{ t('recipient.unsubscribe.submit') }}</span>
				</UiButton>

				<p class="mt-6 text-xs text-text-tertiary">{{ t('recipient.unsubscribe.footnote') }}</p>
			</div>
		</div>

		<!-- Footer -->
		<I18nT keypath="common.poweredBy" tag="p" scope="global" class="text-sm text-text-tertiary">
			<template #brand><span class="font-display">Owlat</span></template>
		</I18nT>
	</div>
</template>
