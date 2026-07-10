<script setup lang="ts">
// Campaign reports are now part of the campaign command center at
// /dashboard/campaigns. Sent-campaign performance lives behind the "Sent"
// pill, so this route redirects there (per-campaign reports keep their own
// /dashboard/campaigns/:id/report pages).
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

await navigateTo(
	{ path: '/dashboard/campaigns', query: { status: 'sent' } },
	{ replace: true, redirectCode: 301 }
);
</script>

<template>
	<div />
</template>
