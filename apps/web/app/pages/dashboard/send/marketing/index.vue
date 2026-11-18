<script setup lang="ts">
/**
 * Retired route: every template, whatever its type, is in the one list at
 * `/dashboard/send`. Old links and bookmarks land there with their query.
 * A route-level redirect, like every other retired page.
 */
definePageMeta({
	redirect: (to) => ({ path: '/dashboard/send', query: to.query, hash: to.hash }),
});
</script>

<template>
	<div />
</template>
