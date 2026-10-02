<script setup lang="ts">
/**
 * The open message is not there for this viewer (#1100): `getMessage`
 * answered `null` because the message was deleted, moved by another mail app,
 * purged from Trash, or its mailbox is no longer shared with them. Shown in
 * place of the reader (Postbox) and of the conversation (Answer mode), which
 * pass the way out as the action.
 */
const { t } = useI18n();
</script>

<template>
	<div class="flex h-full items-center justify-center" data-testid="postbox-message-not-found">
		<UiEmptyState
			icon="lucide:mail-x"
			:title="t('components.postbox.postboxMessageNotFound.title')"
			:description="t('components.postbox.postboxMessageNotFound.body')"
		>
			<template v-if="$slots['action']" #action>
				<slot name="action" />
			</template>
		</UiEmptyState>
	</div>
</template>
