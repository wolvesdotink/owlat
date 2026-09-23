<script setup lang="ts">
/**
 * The personal Reply Queue became part of the Answer queue, which covers
 * every inbox (plus team drafts and chat mentions). Old links — bookmarks,
 * the desktop unread pill, reminder emails — land on the Answer queue
 * filtered to the inbox that was active here.
 */
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { activeMailboxId } = usePostboxActiveMailbox();
await navigateTo(
	{ path: '/dashboard/answer', query: activeMailboxId.value ? { in: activeMailboxId.value } : {} },
	{ replace: true }
);
</script>

<template>
	<div />
</template>
