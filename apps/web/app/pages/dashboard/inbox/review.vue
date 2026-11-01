<script setup lang="ts">
/**
 * Retired route: the Answer queue, filtered to the team inbox, is the one
 * place drafts are reviewed and sent, and old links land there. There is no
 * bulk approve/reject: drafts are reviewed one card at a time, with the
 * shortcuts each card shows.
 */
definePageMeta({
	redirect: { path: '/dashboard/answer', query: { in: 'team' } },
});
</script>

<template>
	<div />
</template>
