<script setup lang="ts">
/**
 * Redirect only. The email theme page grew into the brand kit; the route
 * survives because bookmarks and older links still point here.
 */
definePageMeta({
	redirect: '/dashboard/admin/instance/brand-kit',
	// The target page runs these too; kept so the stub itself never renders unguarded.
	middleware: ['auth', 'admin'],
});
</script>

<template>
	<div />
</template>
