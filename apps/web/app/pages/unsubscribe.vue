<script setup lang="ts">
import { fetchPublicToken } from '~/lib/publicTokenClient';
import { useRecipientTokenFlow } from '~/composables/useRecipientTokenFlow';
import RecipientStateCard from '~/components/recipient/RecipientStateCard.vue';

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

const { senderName, contactEmail, logo } = useRecipientSender();

interface UnsubscribeContact {
	email: string;
	firstName?: string;
	subscribed: boolean;
	organizationName: string;
}

interface UnsubscribeOutcome {
	alreadyUnsubscribed?: boolean;
}

// Verify is outcome mode (200 either way), the one-click POST is action mode;
// the client reads the reason out of both.
const {
	state,
	data: contact,
	errorKey,
	isProcessing,
	run,
} = useRecipientTokenFlow({
	verify: (token) => fetchPublicToken<UnsubscribeContact>('unsub/verify', token),
	missingTokenKey: 'recipient.unsubscribe.errors.missingToken',
	reasons: { expired: 'recipient.unsubscribe.errors.expired' },
	fallbackKey: 'recipient.unsubscribe.errors.invalid',
	unreachableKey: 'recipient.unsubscribe.errors.verifyFailed',
});

/** The POST found nothing left to remove: the second click on the same link. */
const wasAlreadyUnsubscribed = ref(false);

async function handleUnsubscribe() {
	const result = await run(
		(token) => fetchPublicToken<UnsubscribeOutcome>('unsub', token, { method: 'POST' }),
		{ fallbackKey: 'recipient.unsubscribe.errors.processFailed' }
	);
	if (result?.ok) wasAlreadyUnsubscribed.value = result.data.alreadyUnsubscribed === true;
}
</script>

<template>
	<!-- Recipient-facing page: opened from an email client, mostly on a phone.
	     Single column, dvh (mobile browser chrome collapses the visual viewport)
	     and safe-area padding so nothing sits under a notch or home indicator. -->
	<div
		class="flex min-h-dvh flex-col items-center justify-center gap-8 bg-bg-deep px-5 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] text-text-primary"
	>
		<!-- The sender, not Owlat: the recipient knows who emailed them. -->
		<RecipientHeader
			:name="senderName"
			:logo="logo"
			:purpose="t('recipient.shared.emailPreferences')"
		/>

		<RecipientStateCard
			v-if="state === 'loading'"
			variant="loading"
			:message="t('recipient.shared.verifying')"
		/>

		<RecipientStateCard
			v-else-if="state === 'error'"
			variant="error"
			:heading="t('recipient.unsubscribe.errorHeading')"
			:message="errorKey ? t(errorKey) : undefined"
		>
			<RecipientContactHint :email="contactEmail" keypath="recipient.shared.contactToOptOut" />
		</RecipientStateCard>

		<!-- break-words: contact emails and org names are unbounded strings and
		     these cards are read at 320px. -->
		<RecipientStateCard
			v-else-if="state === 'done'"
			variant="success"
			:heading="
				wasAlreadyUnsubscribed
					? t('recipient.unsubscribe.alreadyHeading')
					: t('recipient.unsubscribe.successHeading')
			"
		>
			<I18nT
				:keypath="
					wasAlreadyUnsubscribed
						? 'recipient.unsubscribe.alreadyBody'
						: 'recipient.unsubscribe.successBody'
				"
				tag="p"
				scope="global"
				class="mb-6 break-words text-text-secondary"
			>
				<template #organization
					><strong>{{ contact?.organizationName }}</strong></template
				>
			</I18nT>
			<I18nT
				keypath="recipient.unsubscribe.successNote"
				tag="p"
				scope="global"
				class="text-sm break-words text-text-tertiary"
			>
				<template #email
					><strong>{{ contact?.email }}</strong></template
				>
			</I18nT>
		</RecipientStateCard>

		<!-- Already unsubscribed before the button was ever pressed. -->
		<RecipientStateCard
			v-else-if="contact && !contact.subscribed"
			variant="already"
			:heading="t('recipient.unsubscribe.alreadyHeading')"
		>
			<I18nT
				keypath="recipient.unsubscribe.alreadyStateBody"
				tag="p"
				scope="global"
				class="break-words text-text-secondary"
			>
				<template #organization
					><strong>{{ contact.organizationName }}</strong></template
				>
			</I18nT>
			<I18nT
				keypath="recipient.unsubscribe.alreadyStateNote"
				tag="p"
				scope="global"
				class="mt-4 text-sm break-words text-text-tertiary"
			>
				<template #email
					><strong>{{ contact.email }}</strong></template
				>
			</I18nT>
		</RecipientStateCard>

		<RecipientStateCard
			v-else-if="contact"
			variant="prompt"
			tone="neutral"
			:heading="t('recipient.unsubscribe.confirmHeading')"
		>
			<p class="mb-6 break-words text-text-secondary">
				<template v-if="contact.firstName">
					{{ t('recipient.unsubscribe.greeting', { name: contact.firstName }) }}
				</template>
				<I18nT keypath="recipient.unsubscribe.confirmBody" tag="span" scope="global">
					<template #email
						><strong>{{ contact.email }}</strong></template
					>
					<template #organization
						><strong>{{ contact.organizationName }}</strong></template
					>
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
		</RecipientStateCard>

		<RecipientFooter />
	</div>
</template>
