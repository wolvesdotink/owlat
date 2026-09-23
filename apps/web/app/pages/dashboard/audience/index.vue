<script setup lang="ts">
/**
 * Audience opens on the contact list (#787). Topics, segments and
 * suppressions are tabs beside it (`AudienceTabs`), so the old overview of
 * stat tiles, quick actions and a second "Add contact" is gone. The route
 * stays so every existing link keeps working, and its query string is carried
 * over: `/dashboard/audience?action=add` still opens the add-contact form.
 */
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();

await navigateTo(
	{ path: '/dashboard/audience/contacts', query: route.query, hash: route.hash },
	{ replace: true }
);
</script>

<template>
	<div />
</template>
