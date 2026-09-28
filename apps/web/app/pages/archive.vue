<script setup lang="ts">
import { fetchPublicToken } from '~/lib/publicTokenClient';
import { useRecipientTokenFlow } from '~/composables/useRecipientTokenFlow';
import RecipientStateCard from '~/components/recipient/RecipientStateCard.vue';
import PublicEmailFrame from '~/components/recipient/PublicEmailFrame.vue';

const { t, locale } = useI18n();

useHead({ title: () => t('recipient.archive.pageTitle') });

definePageMeta({
	layout: false,
});

interface ArchiveData {
	html: string;
	subject: string;
	sentAt: number;
	organizationName: string;
}

// `archive_not_found` (a bad token, or archiving switched off) is the one
// reason the endpoint sends; anything else is a failed load.
const {
	state,
	data: archiveData,
	errorKey,
} = useRecipientTokenFlow({
	verify: (token) => fetchPublicToken<ArchiveData>('archive', token),
	missingTokenKey: 'recipient.archive.errors.missingToken',
	reasons: { archive_not_found: 'recipient.archive.errors.unavailable' },
	fallbackKey: 'recipient.archive.errors.loadFailed',
});

// Format sent date in the active UI locale, not a pinned en-US.
const formattedDate = computed(() => {
	if (!archiveData.value?.sentAt) return '';
	return new Intl.DateTimeFormat(locale.value, {
		month: 'long',
		day: 'numeric',
		year: 'numeric',
	}).format(new Date(archiveData.value.sentAt));
});

// SEO
useSeoMeta({
	title: () =>
		archiveData.value
			? t('recipient.archive.seoTitleLoaded', {
					subject: archiveData.value.subject,
					organization: archiveData.value.organizationName,
				})
			: t('recipient.archive.seoTitle'),
	ogTitle: () => archiveData.value?.subject ?? t('recipient.archive.seoTitle'),
	ogDescription: () =>
		archiveData.value
			? t('recipient.archive.ogDescription', { organization: archiveData.value.organizationName })
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
				:message="t('recipient.archive.loading')"
			/>
			<RecipientStateCard
				v-else
				bare
				variant="error"
				:heading="t('recipient.archive.errorHeading')"
				:message="errorKey ? t(errorKey) : undefined"
			/>
		</div>

		<PublicEmailFrame
			v-else-if="archiveData"
			:subject="archiveData.subject"
			:html="archiveData.html"
			:frame-title="t('recipient.archive.frameTitle')"
		>
			<template #meta>
				<p class="mt-1 text-sm break-words text-text-secondary">
					{{ archiveData.organizationName }}
					<span v-if="formattedDate"> &middot; {{ formattedDate }}</span>
				</p>
			</template>
		</PublicEmailFrame>
	</div>
</template>
