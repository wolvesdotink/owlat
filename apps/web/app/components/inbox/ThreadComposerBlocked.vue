<script setup lang="ts">
/**
 * What the Team inbox reply shows instead of a composer when nothing can be
 * sent: who the reply would go to and why it cannot, never a box that would
 * fail on submit. The `action` slot holds the one way forward, when there is
 * one. Split out of {@link ThreadComposer} to keep it under the file-size
 * ratchet.
 */
import { ReplyIcon } from '@coolicons/vue';
import { REPLY_BLOCKER_KEYS, type ReplyBlocker } from '~/utils/teamThreadReply';

defineProps<{
	/** Why nothing can be sent. */
	blocker: ReplyBlocker;
	/** Who a reply goes to ("To Ana Ruiz"). */
	senderLabel: string;
}>();

const { t } = useI18n();
</script>

<template>
	<div class="flex items-start gap-3 p-4" data-testid="thread-composer-blocked">
		<ReplyIcon class="mt-0.5 size-4 shrink-0 text-text-tertiary" />
		<div class="min-w-0">
			<p class="text-sm text-text-secondary">
				{{ t('dashboard.inbox.detail.composer.replyTo', { name: senderLabel }) }}
			</p>
			<p class="mt-1 text-xs text-text-tertiary">{{ t(REPLY_BLOCKER_KEYS[blocker]) }}</p>
			<div v-if="$slots['action']" class="mt-2">
				<slot name="action" />
			</div>
		</div>
	</div>
</template>
