<script setup lang="ts">
definePageMeta({ layout: 'dashboard', middleware: 'auth' });
await navigateTo('/dashboard/admin/delivery', { replace: true });
</script>

<template><div /></template>
