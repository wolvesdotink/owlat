<script setup lang="ts">
/**
 * The unread mark that leads a Postbox row's sender: an accent dot and, for a
 * row whose accessible name is its text, a screen-reader-only "Unread." so the
 * state is spoken before the sender rather than only shown in weight.
 *
 * The dot is always rendered for an unread row and hidden by CSS unless the
 * Postbox root's `data-unread-style` asks for it (postbox-unread.css), so the
 * row never branches on the user's unread style. Its presence is also what the
 * tint style keys off.
 */
defineProps<{
	/**
	 * Speak "Unread." before the sender. Off where the row already carries an
	 * aria-label that names the unread state (the conversation rows).
	 */
	announce?: boolean;
}>();

const { t } = useI18n();
</script>

<template>
	<!-- The trailing space keeps "Unread." and the sender apart in the name. -->
	<span class="pbx-unread-dot" aria-hidden="true" /><span v-if="announce" class="sr-only"
		>{{ t('components.postbox.postboxUnreadMark.unread') }}{{ ' ' }}</span
	>
</template>
