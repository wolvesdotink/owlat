<script setup lang="ts">
// The standalone "All campaigns" list is now folded into the campaign command
// center at /dashboard/campaigns. This route redirects there, preserving any
// ?status= deep-link (which maps straight onto the command center's filter
// pills), so existing links keep working.
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
await navigateTo(
	{ path: '/dashboard/campaigns', query: route.query },
	{ replace: true, redirectCode: 301 }
);
</script>

<template>
	<div />
</template>
