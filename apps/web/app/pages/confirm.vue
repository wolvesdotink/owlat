<script setup lang="ts">
import { api } from '@owlat/api';
import type { PublicTokenResult } from '~/lib/publicTokenClient';
import { useRecipientTokenFlow } from '~/composables/useRecipientTokenFlow';
import RecipientStateCard from '~/components/recipient/RecipientStateCard.vue';

const { t } = useI18n();

useHead({ title: () => t('recipient.confirm.pageTitle') });

// Public confirmation page - no auth middleware needed
definePageMeta({
	layout: false, // No dashboard layout, standalone page
});

const convex = useConvex();
const { senderName, contactEmail, logo } = useRecipientSender();

interface SubmissionInfo {
	email: string;
	organizationName: string;
	status: string;
	confirmedAt?: number;
}

// The double opt-in token is read through the Convex client, not the HTTP
// site, so both steps adapt its answers to the flow's `{ ok, reason }` result.
// The mutation's `error` codes are the reasons.
const {
	state,
	data: submission,
	errorKey,
	isProcessing,
	run,
} = useRecipientTokenFlow({
	verify: async (token): Promise<PublicTokenResult<SubmissionInfo>> => {
		if (!convex) return { ok: false, reason: 'no_server' };
		const found = await convex.query(api.forms.endpoints.getByConfirmationToken, { token });
		return found ? { ok: true, data: found } : { ok: false, reason: 'invalid_token' };
	},
	missingTokenKey: 'recipient.confirm.errors.missingToken',
	reasons: {
		invalid_token: 'recipient.confirm.errors.invalid',
		invalid_status: 'recipient.confirm.errors.alreadyProcessed',
		token_expired: 'recipient.confirm.errors.expired',
		no_server: 'recipient.confirm.errors.noServer',
	},
	fallbackKey: 'recipient.confirm.errors.invalid',
	unreachableKey: 'recipient.confirm.errors.verifyFailed',
});

const isAlreadyConfirmed = computed(
	() => submission.value?.status === 'success' && !!submission.value.confirmedAt
);

/** The mutation found the subscription confirmed already (a second click). */
const wasAlreadyConfirmed = ref(false);

async function handleConfirm() {
	if (!convex) return;
	const result = await run(
		async (token): Promise<PublicTokenResult<boolean>> => {
			const outcome = await convex.mutation(api.forms.endpoints.confirmSubmission, { token });
			return outcome.success
				? { ok: true, data: outcome.alreadyConfirmed }
				: { ok: false, reason: outcome.error };
		},
		{ fallbackKey: 'recipient.confirm.errors.confirmFailed' }
	);
	if (result?.ok) wasAlreadyConfirmed.value = result.data;
}
</script>

<template>
	<!-- Recipient-facing page: opened from an email client, mostly on a phone.
	     Single column, dvh (mobile browser chrome collapses the visual viewport)
	     and safe-area padding so nothing sits under a notch or home indicator. -->
	<div
		class="flex min-h-dvh flex-col items-center justify-center gap-8 bg-bg-deep px-5 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] text-text-primary"
	>
		<!-- The sender, not Owlat: the recipient knows who they signed up with. -->
		<RecipientHeader :name="senderName" :logo="logo" :purpose="t('recipient.confirm.header')" />

		<RecipientStateCard
			v-if="state === 'loading'"
			variant="loading"
			:message="t('recipient.shared.verifying')"
		/>

		<RecipientStateCard
			v-else-if="state === 'error'"
			variant="error"
			:heading="t('recipient.confirm.errorHeading')"
			:message="errorKey ? t(errorKey) : undefined"
		>
			<RecipientContactHint :email="contactEmail" keypath="recipient.shared.contactSender" />
		</RecipientStateCard>

		<!-- break-words: contact emails and org names are unbounded strings and
		     these cards are read at 320px. -->
		<RecipientStateCard
			v-else-if="state === 'done'"
			variant="success"
			:heading="
				wasAlreadyConfirmed
					? t('recipient.confirm.alreadyHeading')
					: t('recipient.confirm.successHeading')
			"
		>
			<I18nT
				:keypath="
					wasAlreadyConfirmed ? 'recipient.confirm.alreadyBody' : 'recipient.confirm.successBody'
				"
				tag="p"
				scope="global"
				class="mb-6 break-words text-text-secondary"
			>
				<template #organization
					><strong>{{ submission?.organizationName }}</strong></template
				>
			</I18nT>
			<I18nT
				keypath="recipient.confirm.successNote"
				tag="p"
				scope="global"
				class="text-sm break-words text-text-tertiary"
			>
				<template #email
					><strong>{{ submission?.email }}</strong></template
				>
			</I18nT>
		</RecipientStateCard>

		<!-- Confirmed already before the button was ever pressed. -->
		<RecipientStateCard
			v-else-if="submission && isAlreadyConfirmed"
			variant="already"
			:heading="t('recipient.confirm.alreadyHeading')"
		>
			<I18nT
				keypath="recipient.confirm.alreadyStateBody"
				tag="p"
				scope="global"
				class="break-words text-text-secondary"
			>
				<template #organization
					><strong>{{ submission.organizationName }}</strong></template
				>
			</I18nT>
			<I18nT
				keypath="recipient.confirm.alreadyStateNote"
				tag="p"
				scope="global"
				class="mt-4 text-sm break-words text-text-tertiary"
			>
				<template #email
					><strong>{{ submission.email }}</strong></template
				>
			</I18nT>
		</RecipientStateCard>

		<RecipientStateCard
			v-else-if="submission"
			variant="prompt"
			:heading="t('recipient.confirm.confirmHeading')"
		>
			<I18nT
				keypath="recipient.confirm.confirmBody"
				tag="p"
				scope="global"
				class="mb-6 break-words text-text-secondary"
			>
				<template #organization
					><strong>{{ submission.organizationName }}</strong></template
				>
				<template #email
					><strong>{{ submission.email }}</strong></template
				>
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
				{{ t('recipient.confirm.footnote', { organization: submission.organizationName }) }}
			</p>
		</RecipientStateCard>

		<RecipientFooter />
	</div>
</template>
