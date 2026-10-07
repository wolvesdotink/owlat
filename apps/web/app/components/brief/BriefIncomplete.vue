<script setup lang="ts">
/**
 * Says what the Overview does NOT know (plan §8). The worst failure is a brief
 * that reads as reassuring when it should not, so every gap is said out loud:
 *
 *  - partly read: how many messages are in the overview, why the rest is
 *    not, and the way to the original;
 *  - still reading, or no overview at all (and why: AI off, undecryptable,
 *    not eligible, failed);
 *  - short mail and security mail, shown as written;
 *  - signed mail: only the signed part was read.
 */
import type { BriefModeView } from '../../../../api/convex/mail/interpret/briefShape';
import { briefBanners } from '~/utils/threadBriefBanners';
import { useLocalized } from '~/composables/useLocalized';

const props = defineProps<{
	/** null: no brief at all. */
	brief: BriefModeView | null;
	/** A clearsigned message in the thread: the overview only covers the signed part. */
	isSigned?: boolean;
}>();

const emit = defineEmits<{ 'open-conversation': [] }>();

const { t } = useI18n();
const localized = useLocalized();
const banners = computed(() => briefBanners(props.brief, { isSigned: props.isSigned }));

const TONE: Record<string, string> = {
	warn: 'bg-warning-subtle text-warning',
	info: 'bg-info-subtle text-info',
	err: 'bg-error-subtle text-error',
	neutral: 'bg-bg-surface text-text-secondary',
};
const ICON: Record<string, string> = {
	warn: 'lucide:triangle-alert',
	info: 'lucide:info',
	err: 'lucide:shield-alert',
	neutral: 'lucide:file-text',
};
</script>

<template>
	<div v-if="banners.length > 0" class="space-y-2">
		<div
			v-for="banner in banners"
			:key="banner.key"
			role="status"
			class="flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
			:class="TONE[banner.tone]"
			data-testid="brief-incomplete"
			:data-kind="banner.key"
		>
			<Icon :name="ICON[banner.tone]!" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
			<p class="min-w-0 flex-1">
				<b v-if="banner.lead" class="font-medium">{{ t(banner.lead) }}</b>
				{{ localized(banner.text) }}
			</p>
			<button
				v-if="banner.offersConversation"
				type="button"
				class="shrink-0 font-medium underline-offset-2 hover:underline"
				data-testid="brief-open-conversation"
				@click="emit('open-conversation')"
			>
				{{ t('components.brief.incomplete.openConversation') }}
			</button>
		</div>
	</div>
</template>
