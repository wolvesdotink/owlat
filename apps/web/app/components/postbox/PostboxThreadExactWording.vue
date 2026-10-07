<script setup lang="ts">
/**
 * "Read the exact wording" (SPEC §7, plan §8 "Terms or legal notice"): the
 * originals of the messages whose wording matters more than any summary of
 * it (a legal notice, changed terms, payment details), open by default next
 * to the brief rather than behind it. The brief gives the gist; this keeps
 * the conditions in front of the reader as written.
 *
 * A message whose body the reader shows through its security badge instead
 * (encrypted, clearsigned) is not rendered here; the Conversation is the way
 * to it, and the panel says so.
 */
import { isEncryptedClass, type SecureMessageClass } from '@owlat/shared/secureMessage';
import { formatDateTime } from '~/utils/formatters';
import type { PostboxReaderMessage } from './PostboxThreadReader.vue';

const props = defineProps<{
	messages: readonly PostboxReaderMessage[];
	secureClass: (msg: { _id: string }) => SecureMessageClass;
}>();

const emit = defineEmits<{ 'open-conversation': [] }>();

const { t } = useI18n();
const open = ref(true);

/**
 * Encrypted, clearsigned, or carrying any signature verdict: the reader binds
 * such a body to its verdict (usePostboxSignedBody), which only the full
 * message card does, so it is not rendered bare here.
 */
function isBodyHidden(msg: PostboxReaderMessage): boolean {
	const c = props.secureClass(msg);
	return isEncryptedClass(c) || c === 'pgp-clearsigned' || !!msg.inboundSignatureInfo?.isSigned;
}
</script>

<template>
	<details
		v-if="messages.length > 0"
		:open="open"
		class="rounded-xl border border-border-subtle bg-bg-elevated"
		data-testid="exact-wording"
		@toggle="open = ($event.target as HTMLDetailsElement).open"
	>
		<summary class="cursor-pointer px-4 py-2.5 text-sm font-medium text-text-primary">
			{{ t('components.brief.exactWording.title') }}
			<span class="ml-1 text-xs font-normal text-text-tertiary">{{
				t('components.brief.exactWording.hint')
			}}</span>
		</summary>
		<section
			v-for="msg in messages"
			:key="msg._id"
			class="border-t border-border-subtle px-4 py-3"
			data-testid="exact-wording-message"
		>
			<p class="text-xs text-text-tertiary">
				<span class="font-medium text-text-secondary">{{ msg.fromName || msg.fromAddress }}</span>
				· {{ formatDateTime(msg.receivedAt) }}
			</p>
			<p v-if="isBodyHidden(msg)" class="mt-2 text-xs text-text-secondary">
				{{ t('components.brief.exactWording.secured') }}
				<button type="button" class="text-brand hover:underline" @click="emit('open-conversation')">
					{{ t('components.brief.incomplete.openConversation') }}
				</button>
			</p>
			<PostboxMessageBody v-else :message="msg" />
		</section>
	</details>
</template>
