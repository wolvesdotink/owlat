<script setup lang="ts">
/**
 * Settings → Email delivery → Advanced: one sidebar row for the four ramp
 * pages, which the admin layout renders as tabs. The row itself opens the first
 * tab.
 */
definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
	redirect: '/dashboard/admin/delivery/advanced/controls',
});
</script>

<template>
	<div />
</template>
