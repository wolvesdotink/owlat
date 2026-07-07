<script setup lang="ts">
useHead({ title: 'Reply Queue — Owlat' });
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

// The Reply Queue is now the focused card-stack flow (one task at a time,
// auto-advancing) rather than a two-section listbox. PostboxReplyFlow owns the
// snapshot, ordering, progress, and every queue action (Answer / Review & send
// / Draft reply / Done / Snooze / Archive / Open). The rail link, the inbox
// strip, and the a1a For-you buttons all open this page.
const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);
</script>

<template>
	<div class="h-[calc(100vh-4rem)] overflow-auto bg-bg-base">
		<PostboxReplyFlow v-if="mailboxId" :mailbox-id="mailboxId" />
		<div v-else-if="!mailboxesLoading" class="h-full flex items-center justify-center p-12">
			<div class="text-center max-w-md">
				<Icon name="lucide:mailbox" class="w-12 h-12 mx-auto text-text-tertiary" />
				<h2 class="text-xl font-semibold mt-4">No mailbox yet</h2>
				<p class="text-text-secondary mt-2">
					Provision your first personal mailbox to start receiving mail.
				</p>
				<NuxtLink to="/dashboard/postbox/settings/add-account" class="btn btn-primary mt-6">
					Add mail account
				</NuxtLink>
			</div>
		</div>
		<div v-else class="h-full flex items-center justify-center">
			<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
		</div>
	</div>
</template>
