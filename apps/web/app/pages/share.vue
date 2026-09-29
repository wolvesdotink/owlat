<script setup lang="ts">
import { fetchPublicToken } from '~/lib/publicTokenClient';
import { useRecipientTokenFlow } from '~/composables/useRecipientTokenFlow';
import RecipientStateCard from '~/components/recipient/RecipientStateCard.vue';
import PublicEmailFrame from '~/components/recipient/PublicEmailFrame.vue';

const { t } = useI18n();

useHead({ title: () => t('recipient.share.pageTitle') });

definePageMeta({
	layout: false,
});

interface ShareLinkData {
	html: string;
	subject: string;
	previewText?: string;
	organizationName: string;
	expiresAt: number;
}

// The endpoint answers an expired link with 404 and `reason: 'expired'` in the
// error envelope (the error taxonomy has no Gone), so "expired" is read from
// the reason, never from the status.
const {
	state,
	data: shareData,
	errorKey,
	reason,
} = useRecipientTokenFlow({
	verify: (token) => fetchPublicToken<ShareLinkData>('share', token),
	missingTokenKey: 'recipient.share.errors.missingToken',
	fallbackKey: 'recipient.share.errors.revoked',
	unreachableKey: 'recipient.share.errors.loadFailed',
});

const isExpired = computed(() => state.value === 'error' && reason.value === 'expired');

// Countdown: hours remaining
const hoursRemaining = computed(() => {
	if (!shareData.value?.expiresAt) return 0;
	const ms = shareData.value.expiresAt - Date.now();
	return Math.max(0, Math.ceil(ms / (1000 * 60 * 60)));
});

// SEO
useSeoMeta({
	title: () =>
		shareData.value
			? t('recipient.share.seoTitleLoaded', {
					subject: shareData.value.subject,
					organization: shareData.value.organizationName,
				})
			: t('recipient.share.seoTitle'),
	ogTitle: () => shareData.value?.subject ?? t('recipient.share.seoTitle'),
	ogDescription: () =>
		shareData.value
			? t('recipient.share.ogDescription', { organization: shareData.value.organizationName })
			: undefined,
});
</script>

<template>
	<div class="min-h-dvh bg-bg-deep text-text-primary">
		<div v-if="state !== 'ready'" class="flex min-h-dvh items-center justify-center px-5">
			<RecipientStateCard
				v-if="state === 'loading'"
				bare
				variant="loading"
				:message="t('recipient.share.loading')"
			/>
			<RecipientStateCard
				v-else-if="isExpired"
				bare
				variant="expired"
				:heading="t('recipient.share.expiredHeading')"
				:message="t('recipient.share.expiredBody')"
			/>
			<RecipientStateCard
				v-else
				bare
				variant="error"
				:heading="t('recipient.share.errorHeading')"
				:message="errorKey ? t(errorKey) : undefined"
			/>
		</div>

		<PublicEmailFrame
			v-else-if="shareData"
			:subject="shareData.subject"
			:html="shareData.html"
			:frame-title="t('recipient.share.frameTitle')"
		>
			<template #meta>
				<p class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
					<span class="break-words">{{ shareData.organizationName }}</span>
					<span
						v-if="hoursRemaining > 0"
						class="inline-flex items-center gap-1 text-xs text-text-tertiary"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							class="h-3 w-3 shrink-0"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							aria-hidden="true"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
							/>
						</svg>
						{{ t('recipient.share.expiresIn', { hours: hoursRemaining }) }}
					</span>
				</p>
			</template>
		</PublicEmailFrame>
	</div>
</template>
