<script setup lang="ts">
// Redirect stub: this page moved to /dashboard/inbox/activity when the
// cross-channel feed was renamed "All activity" ("channels" now refers only
// to the messaging integrations in Settings). Kept so old links keep working.
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

await navigateTo('/dashboard/inbox/activity', { replace: true });
</script>

<template>
	<div />
</template>
