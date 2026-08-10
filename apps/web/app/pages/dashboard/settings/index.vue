<script setup lang="ts">
definePageMeta({ layout: 'dashboard', middleware: 'auth' });
const { isLoading } = useOrganizationContext();
await waitForLoaded(isLoading);
const { isAdmin } = usePermissions();
await navigateTo(isAdmin.value ? '/dashboard/admin' : '/dashboard/preferences', { replace: true });
</script>

<template><div /></template>
