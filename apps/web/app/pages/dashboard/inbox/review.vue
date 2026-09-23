<script setup lang="ts">
/**
 * Retired: "Team drafts to review" was a second answer queue with its own
 * layout, colours and shortcut legend. The Answer queue, filtered to the team
 * inbox, is the one place drafts are reviewed and sent; old links land there.
 * Its bulk approve/reject list went with it on purpose (#767): drafts are
 * reviewed one card at a time, with the shortcuts each card shows.
 */
definePageMeta({
	redirect: { path: '/dashboard/answer', query: { in: 'team' } },
});
</script>

<template>
	<div />
</template>
