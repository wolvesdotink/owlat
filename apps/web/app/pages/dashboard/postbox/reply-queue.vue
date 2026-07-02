<script setup lang="ts">
useHead({ title: 'Reply Queue — Owlat' });
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);
const { count } = usePostboxReplyQueue(mailboxId);
</script>

<template>
	<div class="h-[calc(100vh-4rem)] overflow-auto bg-bg-base">
		<div v-if="mailboxId" class="max-w-3xl mx-auto px-6 py-8">
			<header class="flex items-baseline justify-between mb-4">
				<div>
					<h1 class="text-lg font-semibold text-text-primary">Reply Queue</h1>
					<p class="text-sm text-text-secondary mt-0.5">
						{{
							count === 0
								? 'Emails waiting on your reply land here.'
								: `${count} ${count === 1 ? 'email is' : 'emails are'} waiting on your reply.`
						}}
					</p>
				</div>
				<NuxtLink
					to="/dashboard/postbox/inbox"
					class="text-sm text-brand hover:underline flex-shrink-0"
				>
					Back to inbox
				</NuxtLink>
			</header>
			<div class="border border-border-subtle rounded-lg bg-bg-surface overflow-hidden">
				<PostboxReplyQueue :mailbox-id="mailboxId" />
			</div>
		</div>
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
		<PostboxComposerStack />
	</div>
</template>
