<script setup lang="ts">
import { postboxPageTransition } from '~/utils/postboxPageTransition';
definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', postboxPageTransition],
});

// Default to inbox folder
await navigateTo('/dashboard/postbox/inbox', { replace: true });
</script>

<template>
	<div />
</template>
