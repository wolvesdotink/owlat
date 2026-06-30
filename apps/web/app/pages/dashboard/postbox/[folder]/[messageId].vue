<script setup lang="ts">
useHead({ title: 'Mail — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const route = useRoute();
const folderRole = computed(() => String(route.params['folder'] ?? 'inbox'));
const messageId = computed(() => String(route.params['messageId'] ?? ''));
const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);
</script>

<template>
	<div class="flex h-[calc(100vh-4rem)]">
		<PostboxLayout
			v-if="mailboxId"
			:mailbox-id="mailboxId"
			:folder-role="folderRole"
			:active-message-id="messageId"
		/>
		<div v-else-if="!mailboxesLoading" class="flex-1 flex items-center justify-center p-12">
			<p class="text-text-secondary">No mailbox configured</p>
		</div>
		<PostboxComposerStack />
	</div>
</template>
