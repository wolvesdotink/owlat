<script setup lang="ts">
/**
 * Audience opens on the contact list. Topics, segments and
 * suppressions are tabs beside it (`AudienceTabs`), so there is no separate
 * overview with its own "Add contact". The route stays so every existing link
 * keeps working, and its query string is carried over:
 * `/dashboard/audience?action=add` still opens the add-contact form.
 * A route-level redirect, like every other retired page.
 */
definePageMeta({
	redirect: (to) => ({ path: '/dashboard/audience/contacts', query: to.query, hash: to.hash }),
});
</script>

<template>
	<div />
</template>
