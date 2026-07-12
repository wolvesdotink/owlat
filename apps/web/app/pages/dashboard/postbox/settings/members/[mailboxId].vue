<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Team inbox members — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const mailboxId = useRouteId<'mailboxes'>('mailboxId');

const { data: mailbox, isLoading: mailboxLoading } = useConvexQuery(api.mail.mailbox.get, () => ({
	mailboxId: mailboxId.value,
}));
// `mailbox.get` soft-fails to `null` for a bad id, a personal mailbox, or an
// inbox the caller has no access to — distinct from `undefined` (still loading).
const notFound = computed(() => !mailboxLoading.value && mailbox.value === null);
</script>

<template>
	<div class="p-6 lg:p-8 max-w-2xl mx-auto">
		<NuxtLink
			to="/dashboard/postbox/settings"
			class="text-sm text-text-secondary inline-flex items-center gap-1 hover:text-text-primary mb-4"
		>
			<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
			Back to settings
		</NuxtLink>

		<h1 class="text-2xl font-semibold">Team inbox members</h1>
		<p v-if="mailbox" class="text-text-secondary mt-1">
			Who can read and send from <code>{{ mailbox.address }}</code
			>.
		</p>

		<!-- Bad id, a personal mailbox, or an inbox this person can't reach. -->
		<div v-if="notFound" class="card mt-6 p-8 text-center">
			<div
				class="w-12 h-12 mx-auto rounded-full bg-bg-surface flex items-center justify-center text-text-tertiary"
			>
				<Icon name="lucide:folder-x" class="w-6 h-6" />
			</div>
			<h2 class="font-semibold mt-4">This team inbox isn't available</h2>
			<p class="text-text-secondary mt-2 text-sm">
				It doesn't exist, or you don't have access to manage its members.
			</p>
			<NuxtLink to="/dashboard/postbox/settings" class="btn btn-secondary mt-6">
				Back to settings
			</NuxtLink>
		</div>

		<PostboxTeamInboxMembersPanel v-else :mailbox-id="mailboxId" class="mt-6" />
	</div>
</template>
