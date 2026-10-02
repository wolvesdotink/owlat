<script setup lang="ts">
// The email theme page grew into the brand kit; old links and bookmarks land there.
definePageMeta({
	middleware: ['auth', 'admin'],
	redirect: '/dashboard/admin/instance/brand-kit',
});
</script>

<template>
	<div />
</template>
