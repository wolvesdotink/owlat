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
 * The no-mailbox signals (reservation, external-account flag, open request) are
 * fetched HERE from `mail.mailboxRequest.freshStartStatus` + the `mail.external`
 * feature flag, so every caller — the primary Postbox surface and the simple
 * label / search / contacts pages alike — gets the SAME correct next-step state
 * from just `mailboxId` + `loading`. No caller can wire a wrong dead-end.
 */
import { api } from '@owlat/api';
import { deriveMailboxGuardState } from '~/utils/freshStart';

const props = defineProps<{
	mailboxId: string | null;
	loading: boolean;
}>();

// Self-fetched no-mailbox signals. Cheap self-scoped read; the reservation /
// open-request fields only matter in the no-mailbox branches.
const { data: freshStatus, isLoading: freshLoading } = useConvexQuery(
	api.mail.mailboxRequest.freshStartStatus,
	() => ({})
);
const { isEnabled } = useFeatureFlag();
const externalAllowed = computed(() => isEnabled('mail.external'));

const state = computed(() =>
	deriveMailboxGuardState({
		// Keep showing the spinner until the fresh-start signals resolve too, so the
		// dead-end never flashes before flipping to reserved / external.
		loading: props.loading || (!props.mailboxId && freshLoading.value),
		hasMailbox: Boolean(props.mailboxId),
		reservedAddress: freshStatus.value?.reservedAddress ?? null,
		externalAllowed: externalAllowed.value,
	})
);

const reservedAddress = computed(() => freshStatus.value?.reservedAddress ?? null);

const requested = ref(false);
const { run: requestMailbox, isLoading: requesting } = useBackendOperation(
	api.mail.mailboxRequest.request,
	{ label: 'Request a mailbox' }
);

async function askAdmin() {
	// run() resolves undefined on failure (error already toasted); only confirm
	// when the request actually landed, so no false "we've let your admins know".
	const res = await requestMailbox({});
	if (res) requested.value = true;
}

const alreadyAsked = computed(() => Boolean(freshStatus.value?.hasOpenRequest) || requested.value);
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
				you. It'll appear here automatically as soon as it's ready.
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
