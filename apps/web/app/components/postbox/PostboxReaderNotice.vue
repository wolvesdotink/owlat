<script setup lang="ts">
/**
 * The calm reader's one notice slot (read on arrival §3): the single banner
 * `pickReaderNotice` chose for the thread, in the order danger > key change >
 * left draft > image consent.
 *
 * Danger (the latest message is spam or failed DMARC) is said here, at thread
 * level, because the trust chip that also carries it now sits behind Details.
 * The key-change banner arrives through its slot (the reader owns the key
 * state). Image consent renders in place, inside the latest message's body,
 * where its "Show once" lives; this slot then stays empty.
 */
import type { ReaderNoticeKind } from '~/utils/postboxReaderNotice';
import { ShieldWarningIcon } from '@coolicons/vue';

defineProps<{
	kind: ReaderNoticeKind | null;
	danger?: 'spam' | 'dmarc' | null;
	/** The sender-auth summary of a DMARC failure (a catalog message, resolved). */
	dangerText?: string;
}>();

const { t } = useI18n();
</script>

<template>
	<div
		v-if="kind && kind !== 'images'"
		class="mb-3"
		data-reader-chrome="notice"
		:data-notice="kind"
	>
		<div
			v-if="kind === 'danger'"
			role="alert"
			class="px-3 py-2 rounded-md bg-warning/10 text-warning text-xs flex items-center gap-2"
			data-testid="reader-notice-danger"
		>
			<ShieldWarningIcon class="w-4 h-4 flex-shrink-0" aria-hidden="true" />
			<span>{{
				danger === 'spam'
					? t('components.postbox.postboxThreadReader.markedAsSpam')
					: dangerText || t('components.postbox.postboxThreadReader.senderCouldNotBeVerified')
			}}</span>
		</div>
		<slot v-else-if="kind === 'keyChange'" name="keyChange" />
		<PostboxAnswerDraftBar
			v-else-if="kind === 'leftDraft'"
			class="overflow-hidden rounded-md border border-border-subtle"
		/>
	</div>
</template>
