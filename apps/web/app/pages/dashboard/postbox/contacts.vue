<script setup lang="ts">
/** One customer directory: keep the former personal-address-book URL working. */
definePageMeta({ layout: 'dashboard', middleware: 'auth' });
await navigateTo('/dashboard/audience/contacts', { replace: true });
</script>

<template><div /></template>
