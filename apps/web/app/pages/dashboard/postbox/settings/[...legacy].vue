<script setup lang="ts">
definePageMeta({ layout: 'dashboard', middleware: 'auth' });
const route = useRoute();
await navigateTo(legacyDashboardRedirect(route.path) ?? '/dashboard/preferences', {
	replace: true,
});
</script>

<template><div /></template>
