<script setup lang="ts">
/**
 * The operating-mode card sits at the top of Features, and every other Instance
 * page is a row in the settings rail, so this route has no page of its own. It
 * stays so existing links keep working, and carries the query and hash. A
 * route-level redirect, like every other retired page.
 */
definePageMeta({
	redirect: (to) => ({
		path: '/dashboard/admin/instance/features',
		query: to.query,
		hash: to.hash,
	}),
	// The target page runs these too; kept so the stub itself never renders unguarded.
	middleware: ['auth', 'admin'],
});
</script>

<template>
	<div />
</template>
