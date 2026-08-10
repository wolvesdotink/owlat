<script setup lang="ts">
definePageMeta({ layout: 'dashboard', middleware: 'auth' });
await navigateTo('/dashboard/preferences', { replace: true });
</script>

<template><div /></template>
