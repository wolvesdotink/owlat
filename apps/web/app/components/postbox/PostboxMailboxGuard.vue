<script setup lang="ts">
/**
 * Guard every Postbox page opens with. While the mailbox resolves it shows a
 * spinner; once resolved-and-present it renders the page (default slot); once
 * resolved-and-absent it shows an HONEST empty state that tells the member what
 * they can actually do next rather than a mute "no mailbox configured" wall:
 *
 *   - reserved         — a hosted mailbox is reserved for them and is being set
 *                        up; reassure and wait.
 *   - external-allowed — connecting an external account is enabled; point there.
 *   - dead-end         — nothing they can do alone; one click asks an admin
 *                        (self-contained request, surfaced to admins in-app).
 *
 * The three no-mailbox signals are OPTIONAL props so the simple callers (label /
 * search / contacts pages) that only pass `mailboxId` + `loading` still get a
 * correct dead-end state, and the primary Postbox surface can pass the richer
 * signals from `mail.mailboxRequest.freshStartStatus`.
 */
import { api } from '@owlat/api';
import { deriveMailboxGuardState } from '~/utils/freshStart';

const props = withDefaults(
	defineProps<{
		mailboxId: string | null;
		loading: boolean;
		/** Address of an unclaimed hosted reservation for this member, if any. */
		reservedAddress?: string | null;
		/** Connecting an external IMAP/SMTP account is enabled on this instance. */
		externalAllowed?: boolean;
		/** The member already has an open mailbox request (don't offer twice). */
		hasOpenRequest?: boolean;
	}>(),
	{
		reservedAddress: null,
		externalAllowed: false,
		hasOpenRequest: false,
	}
);

const state = computed(() =>
	deriveMailboxGuardState({
		loading: props.loading,
		hasMailbox: Boolean(props.mailboxId),
		reservedAddress: props.reservedAddress,
		externalAllowed: props.externalAllowed,
	})
);

const requested = ref(false);
const { run: requestMailbox, isLoading: requesting } = useBackendOperation(
	api.mail.mailboxRequest.request,
	{ label: 'Request a mailbox' }
);

async function askAdmin() {
	await requestMailbox({});
	requested.value = true;
}

const alreadyAsked = computed(() => props.hasOpenRequest || requested.value);
</script>

<template>
	<div v-if="state === 'loading'" class="flex-1 flex items-center justify-center p-12">
		<Icon
			name="lucide:loader-2"
			class="w-6 h-6 animate-spin text-text-tertiary"
			aria-label="Loading mailbox"
		/>
	</div>

	<slot v-else-if="state === 'ready'" />

	<!-- A hosted mailbox is reserved and provisioning; nothing to do but wait. -->
	<div
		v-else-if="state === 'reserved'"
		class="flex-1 flex items-center justify-center p-12"
		data-testid="mailbox-guard-reserved"
	>
		<div class="w-full max-w-sm text-center">
			<Icon name="lucide:mail-check" class="w-10 h-10 mx-auto text-text-tertiary" />
			<h2 class="text-lg font-semibold text-text-primary mt-4">Your mailbox is being set up</h2>
			<p class="text-sm text-text-secondary mt-2">
				<span class="font-medium text-text-primary">{{ reservedAddress }}</span> is reserved for
				you. It'll appear here as soon as it's ready — reload in a moment.
			</p>
		</div>
	</div>

	<!-- No hosted mailbox, but the member can connect an external account. -->
	<div
		v-else-if="state === 'external-allowed'"
		class="flex-1 flex items-center justify-center p-12"
		data-testid="mailbox-guard-external"
	>
		<div class="w-full max-w-sm text-center">
			<Icon name="lucide:link" class="w-10 h-10 mx-auto text-text-tertiary" />
			<h2 class="text-lg font-semibold text-text-primary mt-4">Connect your mail</h2>
			<p class="text-sm text-text-secondary mt-2">
				You don't have a mailbox here yet — connect an existing account to read and send from it in
				Postbox.
			</p>
			<NuxtLink to="/dashboard/postbox/settings/add-account" class="btn btn-primary mt-6">
				Connect an account
			</NuxtLink>
		</div>
	</div>

	<!-- Honest dead-end: only an admin can give this member a mailbox. -->
	<div
		v-else
		class="flex-1 flex items-center justify-center p-12"
		data-testid="mailbox-guard-deadend"
	>
		<div class="w-full max-w-sm text-center">
			<Icon name="lucide:mailbox" class="w-10 h-10 mx-auto text-text-tertiary" />
			<h2 class="text-lg font-semibold text-text-primary mt-4">No mailbox yet</h2>
			<template v-if="alreadyAsked">
				<p class="text-sm text-text-secondary mt-2">
					We've let your admins know you need a mailbox. You'll see it here once they set one up.
				</p>
			</template>
			<template v-else>
				<p class="text-sm text-text-secondary mt-2">
					Only an admin can set up a mailbox for you. Send them a quick request and they'll get it
					in-app.
				</p>
				<UiButton class="mt-6" :loading="requesting" @click="askAdmin"> Ask an admin </UiButton>
			</template>
		</div>
	</div>
</template>
