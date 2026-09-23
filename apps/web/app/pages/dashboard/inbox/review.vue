<script setup lang="ts">
/**
 * Retired: "Team drafts to review" was a second answer queue with its own
 * layout, colours and shortcut legend. The Answer queue, filtered to the team
 * inbox, is the one place drafts are reviewed and sent; old links land there.
 * The review shortcuts live in the `?` sheet with every other shortcut.
 */
definePageMeta({
	redirect: { path: '/dashboard/answer', query: { in: 'team' } },
});
</script>

<template>
	<div />
</template>
