<script setup lang="ts">
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

// Default to inbox folder
await navigateTo('/dashboard/postbox/inbox', { replace: true });
</script>

<template>
	<div />
</template>
