<script setup lang="ts">
/**
 * "Your mail is sealed" (plan idea 55) — the member-visible half of Sealed Mail.
 *
 * Everything about sealing was an admin surface: the policy page, the key
 * backfill, the recovery kit. A member saw sealed badges on their mail with no
 * way to answer the two questions those badges raise — is MY address actually
 * covered, and what happens to my sealed mail if this server is rebuilt? This
 * card answers exactly those, per address, and says "no key" plainly where
 * that is the truth. A card that only ever reassured would be worse than none.
 *
 * The recovery-kit download is the reason this needs care. It hands over the
 * private key that opens this person's sealed mail, so the session alone is not
 * enough: the password is asked for again and verified SERVER-side
 * (`e2ee/lifecycleNode.ts:exportOwnRecoveryKit`, behind the four-step gate in
 * `e2ee/recoveryKitGate.ts`). Nothing here decides anything — the password never
 * gates the UI, the server refuses and the refusal is what the reader sees, so a
 * tampered client gains nothing.
 *
 * The kit is assembled in memory and downloaded straight from the browser: it is
 * never written to a server-side file, never mailed, and never cached, because
 * every one of those would leave a copy of the key somewhere.
 */
import { api } from '@owlat/api';
import { formatFingerprint } from '~/utils/fingerprints';

const { t } = useI18n();
const { isEnabled } = useFeatureFlag();

const sealedMailEnabled = computed(() => isEnabled('sealedMail'));

const statusQuery = useConvexQuery(api.e2ee.memberKeys.getOwnSealedMailStatus, () =>
	sealedMailEnabled.value ? {} : ('skip' as const)
);
const status = computed(() => statusQuery.data.value ?? null);
const addresses = computed(() => status.value?.addresses ?? []);
const sealedAddresses = computed(() => addresses.value.filter((a) => a.hasKey));

const exportKit = useBackendOperation(api.e2ee.lifecycleNode.exportOwnRecoveryKit, {
	label: () => t('components.postbox.postboxSealedMailCard.exportOperation'),
});

const kitTarget = ref<string | null>(null);
const password = ref('');
/** A catalog key for whatever the server refused with, or null. */
const refusal = ref<string | null>(null);

/** One place mapping each server denial to copy — no reason goes unexplained. */
const REFUSAL_COPY: Record<string, string> = {
	feature_off: 'components.postbox.postboxSealedMailCard.refusal.featureOff',
	not_your_address: 'components.postbox.postboxSealedMailCard.refusal.notYourAddress',
	throttled: 'components.postbox.postboxSealedMailCard.refusal.throttled',
	bad_password: 'components.postbox.postboxSealedMailCard.refusal.badPassword',
	no_key: 'components.postbox.postboxSealedMailCard.refusal.noKey',
};

function openPrompt(address: string) {
	kitTarget.value = address;
	password.value = '';
	refusal.value = null;
}

function closePrompt() {
	kitTarget.value = null;
	// Never leave the password in memory once the dialog is gone.
	password.value = '';
}

async function download() {
	const address = kitTarget.value;
	if (!address || !password.value) return;
	refusal.value = null;
	const result = await exportKit.run({ address, password: password.value });
	if (!result.ok) {
		refusal.value = 'components.postbox.postboxSealedMailCard.refusal.failed';
		return;
	}
	if (!result.result.ok) {
		refusal.value =
			REFUSAL_COPY[result.result.reason] ??
			'components.postbox.postboxSealedMailCard.refusal.failed';
		// The password stays on screen only for a wrong-password retry; every other
		// refusal is not something a re-type fixes.
		if (result.result.reason !== 'bad_password') password.value = '';
		return;
	}
	const kit = result.result.kit;
	// The instructions ride in the same file as the key, because a key file with
	// no explanation is a key file that gets deleted or emailed to somebody.
	const contents = `${kit.instructions}\n\n${kit.privateKeyArmored}\n`;
	const url = URL.createObjectURL(new Blob([contents], { type: 'application/pgp-keys' }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = kit.filename;
	anchor.click();
	URL.revokeObjectURL(url);
	closePrompt();
}
</script>

<template>
	<section
		v-if="sealedMailEnabled && addresses.length > 0"
		id="sealed-mail"
		class="card !p-0 mb-6 scroll-mt-6"
	>
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">
				{{ t('components.postbox.postboxSealedMailCard.heading') }}
			</h2>
			<p class="text-xs text-text-tertiary mt-0.5 max-w-prose">
				{{ t('components.postbox.postboxSealedMailCard.explanation') }}
			</p>
		</header>

		<ul class="divide-y divide-border-subtle">
			<li
				v-for="row in addresses"
				:key="row.address"
				class="px-5 py-3 flex items-center gap-3"
				data-testid="sealed-mail-address"
			>
				<Icon
					:name="row.hasKey ? 'lucide:lock' : 'lucide:lock-open'"
					class="w-4 h-4 shrink-0"
					:class="row.hasKey ? 'text-success' : 'text-text-tertiary'"
				/>
				<div class="min-w-0 flex-1">
					<p class="font-medium text-sm truncate">{{ row.address }}</p>
					<p class="text-xs text-text-tertiary">
						{{
							row.hasKey
								? t('components.postbox.postboxSealedMailCard.hasKey')
								: t('components.postbox.postboxSealedMailCard.noKey')
						}}
					</p>
					<p v-if="row.fingerprint" class="text-xs font-mono text-text-tertiary break-all">
						{{ formatFingerprint(row.fingerprint) }}
					</p>
				</div>
				<UiButton
					v-if="row.hasKey"
					size="sm"
					variant="secondary"
					class="shrink-0"
					data-testid="sealed-mail-kit"
					@click="openPrompt(row.address)"
				>
					{{ t('components.postbox.postboxSealedMailCard.getKit') }}
				</UiButton>
			</li>
		</ul>

		<p v-if="sealedAddresses.length > 0" class="px-5 py-3 text-xs text-text-tertiary max-w-prose">
			{{ t('components.postbox.postboxSealedMailCard.kitHint') }}
		</p>

		<!-- The re-prompt. The server does the verifying; this only collects it. -->
		<UiModal
			:open="!!kitTarget"
			:title="t('components.postbox.postboxSealedMailCard.confirmTitle')"
			size="sm"
			:persistent="exportKit.isLoading.value"
			:closable="!exportKit.isLoading.value"
			@update:open="
				(open: boolean) => {
					if (!open) closePrompt();
				}
			"
		>
			<form class="space-y-3" @submit.prevent="download">
				<p class="text-sm text-text-secondary max-w-prose">
					{{
						t('components.postbox.postboxSealedMailCard.confirmBody', {
							address: kitTarget ?? '',
						})
					}}
				</p>
				<div>
					<label for="sealed-kit-password" class="text-sm font-medium block mb-1">
						{{ t('components.postbox.postboxSealedMailCard.passwordLabel') }}
					</label>
					<input
						id="sealed-kit-password"
						v-model="password"
						type="password"
						autocomplete="current-password"
						class="input w-full"
						data-testid="sealed-mail-password"
					/>
				</div>
				<p v-if="refusal" class="text-sm text-error" data-testid="sealed-mail-refusal">
					{{ t(refusal) }}
				</p>
			</form>
			<template #footer>
				<UiButton variant="secondary" :disabled="exportKit.isLoading.value" @click="closePrompt">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					:loading="exportKit.isLoading.value"
					:disabled="!password"
					data-testid="sealed-mail-confirm"
					@click="download"
				>
					{{ t('components.postbox.postboxSealedMailCard.confirmAction') }}
				</UiButton>
			</template>
		</UiModal>
	</section>
</template>
