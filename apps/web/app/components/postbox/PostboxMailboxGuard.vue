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

const { t } = useI18n();

const props = defineProps<{
	mailboxId: string | null;
	loading: boolean;
}>();

// Self-fetched no-mailbox signals. Cheap self-scoped read; the reservation /
// open-request fields only matter in the no-mailbox branches, so skip the live
// subscription entirely whenever a mailbox exists (the common case). A later
// mailbox loss flips the args back to `{}` and resubscribes.
const { data: freshStatus, isLoading: freshLoading } = useConvexQuery(
	api.mail.mailboxRequest.freshStartStatus,
	() => (props.mailboxId ? 'skip' : {})
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
// True when the reservation's sending domain hasn't verified yet (an early-
// instance invite). The mailbox is held for them and activates automatically the
// moment the domain verifies — progress, not a stalled provision.
const reservationAwaitingDomain = computed(
	() => freshStatus.value?.reservationAwaitingDomain ?? false
);

const requested = ref(false);
const { run: requestMailbox, isLoading: requesting } = useBackendOperation(
	api.mail.mailboxRequest.request,
	{ label: () => t('postbox.mailboxGuard.requestOperation') }
);

async function askAdmin() {
	// run() resolves undefined on failure (error already toasted); only confirm
	// when the request actually landed, so no false "we've let your admins know".
	const res = await requestMailbox({});
	if (res.ok) requested.value = true;
}

const alreadyAsked = computed(() => Boolean(freshStatus.value?.hasOpenRequest) || requested.value);
</script>

<template>
	<div v-if="state === 'loading'" class="flex-1 flex items-center justify-center p-12">
		<Icon
			name="lucide:loader-2"
			class="w-6 h-6 animate-spin text-text-tertiary"
			:aria-label="t('postbox.mailboxGuard.loading')"
		/>
	</div>

	<slot v-else-if="state === 'ready'" />

	<!-- A hosted mailbox is reserved and provisioning; nothing to do but wait.
	     When the reservation's sending domain hasn't verified yet (early-instance
	     invite) the copy names that gate honestly instead of implying it's already
	     provisioning. -->
	<div
		v-else-if="state === 'reserved'"
		class="flex-1 flex items-center justify-center p-12"
		data-testid="mailbox-guard-reserved"
	>
		<div class="w-full max-w-sm text-center">
			<Icon name="lucide:mail-check" class="w-10 h-10 mx-auto text-text-tertiary" />
			<template v-if="reservationAwaitingDomain">
				<h2 class="text-lg font-semibold text-text-primary mt-4">
					{{ t('postbox.mailboxGuard.awaitingDomainHeading') }}
				</h2>
				<I18nT
					keypath="postbox.mailboxGuard.awaitingDomainBody"
					tag="p"
					scope="global"
					class="text-sm text-text-secondary mt-2"
					data-testid="mailbox-guard-reserved-awaiting"
				>
					<template #address
						><span class="font-medium text-text-primary">{{ reservedAddress }}</span></template
					>
				</I18nT>
			</template>
			<template v-else>
				<h2 class="text-lg font-semibold text-text-primary mt-4">
					{{ t('postbox.mailboxGuard.reservedHeading') }}
				</h2>
				<I18nT
					keypath="postbox.mailboxGuard.reservedBody"
					tag="p"
					scope="global"
					class="text-sm text-text-secondary mt-2"
				>
					<template #address
						><span class="font-medium text-text-primary">{{ reservedAddress }}</span></template
					>
				</I18nT>
			</template>
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
			<h2 class="text-lg font-semibold text-text-primary mt-4">
				{{ t('postbox.mailboxGuard.externalHeading') }}
			</h2>
			<p class="text-sm text-text-secondary mt-2">
				{{ t('postbox.mailboxGuard.externalBody') }}
			</p>
			<UiButton to="/dashboard/preferences/add-account" class="mt-6">
				{{ t('postbox.mailboxGuard.externalCta') }}
			</UiButton>
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
			<h2 class="text-lg font-semibold text-text-primary mt-4">
				{{ t('postbox.mailboxGuard.deadEndHeading') }}
			</h2>
			<template v-if="alreadyAsked">
				<p class="text-sm text-text-secondary mt-2">
					{{ t('postbox.mailboxGuard.deadEndAskedBody') }}
				</p>
			</template>
			<template v-else>
				<p class="text-sm text-text-secondary mt-2">
					{{ t('postbox.mailboxGuard.deadEndBody') }}
				</p>
				<UiButton class="mt-6" :loading="requesting" @click="askAdmin">
					{{ t('postbox.mailboxGuard.deadEndCta') }}
				</UiButton>
			</template>
		</div>
	</div>
</template>
