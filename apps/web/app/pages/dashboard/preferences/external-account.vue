<script setup lang="ts">
// The standalone "connect external mailbox" page folded into the unified import
// wizard (Gmail, Fastmail, Outlook, any IMAP — one connect → import → teach-AI
// flow). This route stays alive so existing links and bookmarks don't 404: it
// simply redirects to the wizard, which now also hosts connect / update
// credentials / disconnect / delete for the connected mailbox.
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

await navigateTo('/dashboard/postbox/migrate', { replace: true });
</script>

<template>
	<div class="p-6 flex justify-center">
		<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
	</div>
</template>
