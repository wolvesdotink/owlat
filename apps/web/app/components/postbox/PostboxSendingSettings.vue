<script setup lang="ts">
/**
 * Postbox → Sending: the reversible outbound-transport control for a connected
 * external mailbox (piece c4). After an import a mailbox keeps sending through
 * the user's own SMTP; once their from-domain is verified on THIS instance and a
 * transport is configured, they can flip outbound to the Owlat instance so mail
 * ships from its reputation. Reversible any time.
 *
 * When every gate holds (`promptEligible`) this renders a highlighted nudge at
 * the top — the same one-click switch the post-import checklist points at. We
 * never offer the instance option for an unverified domain: no spoofing a domain
 * this instance can't sign for.
 *
 * Rendered only when the caller actually has a connected external mailbox; a
 * hosted-only user has nothing to choose here, so the section is absent.
 */
import { api } from '@owlat/api';

const { data: status, isLoading } = useConvexQuery(
	api.mail.externalAccounts.sendingSwitchStatus,
	() => ({})
);

const switchError = ref<string | null>(null);
const setPreference = useBackendOperation(api.mail.externalAccounts.setSendingPreference, {
	label: 'Change sending',
	inlineTarget: switchError,
});

// Narrow the discriminated union once, in the script, so the template only ever
// touches plain primitives (vue-tsc doesn't narrow unions across nested tags).
const account = computed(() => (status.value?.configured ? status.value : null));
const showSection = computed(() => isLoading.value || account.value !== null);
const address = computed(() => account.value?.address ?? '');
const domain = computed(() => account.value?.domain ?? '');
const currentPreference = computed(() => account.value?.preference ?? 'external');
const domainVerified = computed(() => account.value?.domainVerified ?? false);
const transportConfigured = computed(() => account.value?.transportConfigured ?? false);
const promptEligible = computed(() => account.value?.promptEligible ?? false);

// The instance option is selectable only when the from-domain is verified here
// AND a transport exists — the same floor the backend enforces.
const canUseInstance = computed(() => domainVerified.value && transportConfigured.value);

async function choose(preference: 'external' | 'instance') {
	if (!account.value) return;
	if (preference === account.value.preference) return;
	if (preference === 'instance' && !canUseInstance.value) return;
	switchError.value = null;
	await setPreference.run({ preference });
}
</script>

<template>
	<section v-if="showSection" class="card !p-0 mb-6" aria-labelledby="postbox-sending-heading">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 id="postbox-sending-heading" class="font-semibold">Sending</h2>
		</header>

		<!-- Loading -->
		<div v-if="isLoading" class="p-8 flex justify-center">
			<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
		</div>

		<template v-else-if="account">
			<!-- Post-import nudge: shown only when every gate holds. -->
			<div
				v-if="promptEligible"
				class="mx-5 mt-4 rounded-md border border-brand/30 bg-brand-subtle px-4 py-3"
			>
				<div class="flex items-start gap-3">
					<Icon name="lucide:send" class="w-5 h-5 text-brand shrink-0 mt-0.5" />
					<div class="min-w-0">
						<p class="font-medium text-sm">Send from this Owlat instead</p>
						<p class="text-xs text-text-secondary mt-1">
							<code>{{ domain }}</code> is verified here, so Owlat can send your outgoing mail
							directly — signed and aligned for <code>{{ domain }}</code
							>. Nothing about how you read mail changes, and you can switch back any time.
						</p>
						<UiButton
							size="sm"
							class="mt-3"
							:loading="setPreference.isLoading.value"
							@click="choose('instance')"
						>
							Switch to Owlat sending
						</UiButton>
					</div>
				</div>
			</div>

			<!-- The reversible choice. -->
			<fieldset class="px-5 py-4">
				<legend class="sr-only">Where outgoing mail is sent from</legend>
				<p class="text-xs text-text-tertiary mb-3">
					Choose where <code>{{ address }}</code> sends its outgoing mail. This only affects sending
					— your inbox keeps syncing exactly as before.
				</p>

				<div class="space-y-2">
					<label
						class="flex items-start gap-3 rounded-md border px-4 py-3 cursor-pointer transition-colors"
						:class="
							currentPreference === 'external'
								? 'border-brand/40 bg-brand-subtle'
								: 'border-border-subtle hover:bg-bg-surface'
						"
					>
						<input
							type="radio"
							name="postbox-sending-transport"
							class="mt-1 shrink-0 h-4 w-4"
							:checked="currentPreference === 'external'"
							:disabled="setPreference.isLoading.value"
							@change="choose('external')"
						/>
						<span class="min-w-0">
							<span class="font-medium text-sm block">Your own mail server</span>
							<span class="text-xs text-text-tertiary block mt-0.5">
								Outgoing mail goes through the outgoing (SMTP) server of the mailbox you connected.
								This is how imported mail sends by default.
							</span>
						</span>
					</label>

					<label
						class="flex items-start gap-3 rounded-md border px-4 py-3 transition-colors"
						:class="[
							canUseInstance ? 'cursor-pointer' : 'cursor-not-allowed opacity-70',
							currentPreference === 'instance'
								? 'border-brand/40 bg-brand-subtle'
								: 'border-border-subtle',
							canUseInstance && currentPreference !== 'instance' ? 'hover:bg-bg-surface' : '',
						]"
					>
						<input
							type="radio"
							name="postbox-sending-transport"
							class="mt-1 shrink-0 h-4 w-4"
							:checked="currentPreference === 'instance'"
							:disabled="setPreference.isLoading.value || !canUseInstance"
							@change="choose('instance')"
						/>
						<span class="min-w-0">
							<span class="font-medium text-sm block">This Owlat instance</span>
							<span class="text-xs text-text-tertiary block mt-0.5">
								Owlat sends your outgoing mail directly, signed for
								<code>{{ domain }}</code
								>. Better deliverability once your domain is set up here.
							</span>
							<span v-if="!domainVerified" class="text-xs text-warning block mt-1">
								Not available yet — <code>{{ domain }}</code> isn't a verified sending domain on
								this instance. Verify it under Settings → Domains first.
							</span>
							<span v-else-if="!transportConfigured" class="text-xs text-warning block mt-1">
								Not available yet — this instance has no outbound transport configured. Set one up
								under Delivery first.
							</span>
						</span>
					</label>
				</div>

				<p v-if="switchError" class="text-sm text-error mt-3">{{ switchError }}</p>
			</fieldset>
		</template>
	</section>
</template>
