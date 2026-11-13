<script setup lang="ts">
/**
 * An open customer email in Answer mode's team column: its body, read when
 * the row opens if the page handed over an envelope (`useTeamMessageBody`),
 * and its attachments. A body on the row renders through the Postbox's
 * sandboxed body component; a body too large for its row through the thread
 * page's, which shows the excerpt and fetches the rest.
 */
import {
	useTeamMessageBody,
	type TeamThreadMessage,
} from '~/composables/team/useTeamThreadMessages';

const props = defineProps<{ message: TeamThreadMessage }>();

const { t } = useI18n();
const full = useTeamMessageBody(() => props.message);

function bodyOf(message: TeamThreadMessage) {
	return {
		_id: message._id,
		htmlBodyInline: message.htmlBody || undefined,
		textBodyInline: message.htmlBody ? undefined : message.textBody || undefined,
		fromAddress: message.from,
	};
}

function hasInlineBody(message: TeamThreadMessage): boolean {
	return Boolean(message.htmlBody || message.textBody?.trim());
}
function hasStoredBody(message: TeamThreadMessage): boolean {
	return message.textBodyStorageId !== undefined || message.htmlBodyStorageId !== undefined;
}
</script>

<template>
	<div class="px-4 pb-4" data-testid="answer-team-message-body">
		<AppErrorBoundary v-if="full" surface="messageBody" :reset-keys="[message._id]">
			<PostboxMessageBody v-if="hasInlineBody(full)" :message="bodyOf(full)" />
			<InboxMessageBody v-else-if="hasStoredBody(full)" :message="full" />
			<p v-else class="text-sm text-text-tertiary">
				{{ t('dashboard.inbox.detail.noTextContent') }}
			</p>
		</AppErrorBoundary>
		<InboxMessageAttachments :message="message" />
	</div>
</template>
