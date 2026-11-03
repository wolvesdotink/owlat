<script setup lang="ts">
import { legacyInboxesRedirect } from '~/utils/postboxAllInboxes';

/**
 * All inboxes is a Postbox view (`/dashboard/postbox/all-inboxes`, see
 * utils/postboxAllInboxes.ts). This route stays for bookmarks and old links,
 * and keeps their `?in=` and `?category=` filters. `?in=team` named the team
 * inbox, which has its own list.
 */
definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', (to) => navigateTo(legacyInboxesRedirect(to.query), { replace: true })],
});
</script>

<template>
	<div />
</template>
