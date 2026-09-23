<script setup lang="ts">
/**
 * Redirect only. AI agent settings and Autonomy rules are now one page, AI
 * replies, which decides drafting and automatic sending in one place. The route
 * survives because bookmarks and older links still point here.
 */
definePageMeta({
	redirect: '/dashboard/admin/instance/ai-replies',
	// The target page runs these too; kept so the stub itself never renders unguarded.
	middleware: ['auth', 'admin'],
});
</script>

<template>
	<div />
</template>
