<script setup lang="ts">
definePageMeta({ layout: 'dashboard', middleware: 'auth' });
const route = useRoute();
const target = legacyDashboardRedirect(route.path);
await navigateTo(target ?? '/dashboard/admin', { replace: true });
</script>

<template><div /></template>
