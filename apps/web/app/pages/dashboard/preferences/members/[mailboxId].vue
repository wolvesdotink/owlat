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
		<PreferencesBackLink />

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
			<!-- The empty state's own way out stays a button — it is the action this
			     dead end offers, not the page's back-link (which is still above it).
			     Only the stale "settings" wording is corrected. -->
			<UiButton variant="secondary" to="/dashboard/preferences" class="mt-6">
				Back to Preferences
			</UiButton>
		</div>

		<PostboxTeamInboxMembersPanel v-else :mailbox-id="mailboxId" class="mt-6" />
	</div>
</template>
