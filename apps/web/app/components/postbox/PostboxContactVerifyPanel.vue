<script setup lang="ts">
/**
 * "Verify this contact" (plan idea 54) — the comparison surface behind the
 * per-contact key panel.
 *
 * Pinning is automatic and says only "this is the key we saw first". Verifying
 * is the thing software cannot do for you: two people compare the same
 * fingerprint over a channel an attacker on the wire does not control. So this
 * panel is not a button — it is three renderings of ONE value, and the button
 * only records what the human concluded:
 *
 *   - the grouped hex fingerprint, the canonical written form;
 *   - a QR code carrying the `OPENPGP4FPR:` URI other OpenPGP tools already
 *     scan, for the case where both people are in the same room;
 *   - the READ-ALOUD numbers, for the far more common case of a phone call —
 *     hex is unspeakable, twenty short decimals are not.
 *
 * The three are the same forty hex characters; none is a hash of another, so
 * whichever one gets compared, the thing compared is the key.
 *
 * The confirm call carries the fingerprint being displayed. If the key rotated
 * while this panel sat open, the server refuses rather than recording a check of
 * a key nobody looked at — the failure is the feature.
 */
import { api } from '@owlat/api';
import { formatFingerprint } from '~/utils/fingerprints';
import { openpgpFingerprintUri } from '~/utils/postboxQrCode';
import { readAloudLines } from '~/utils/postboxKeyVerification';
import type { ContactVerificationState } from '~/utils/postboxKeyVerification';

const props = defineProps<{
	/** The correspondent whose key is being compared. */
	address: string;
	/** The pinned fingerprint — the key Owlat would actually seal to. */
	fingerprint: string;
	/** Where this contact's verification stands right now. */
	state: ContactVerificationState;
}>();

const emit = defineEmits<{
	/** The stored verification changed; the host should re-read the status. */
	changed: [];
}>();

const { t } = useI18n();

const setVerified = useBackendOperation(api.e2ee.recipientKeys.setContactKeyVerified, {
	label: () => t('components.postbox.postboxContactVerifyPanel.operation'),
});

const errored = ref(false);
const grouped = computed(() => formatFingerprint(props.fingerprint));
const qrValue = computed(() => openpgpFingerprintUri(props.fingerprint));
const spokenLines = computed(() => readAloudLines(props.fingerprint));

async function submit(verified: boolean) {
	errored.value = false;
	const result = await setVerified.run({
		address: props.address,
		verified,
		// Only sent when claiming a match: withdrawing needs no fingerprint, and
		// the server treats the two directions differently for that reason.
		...(verified ? { fingerprint: props.fingerprint } : {}),
	});
	if (result.ok) emit('changed');
	else errored.value = true;
}
</script>

<template>
	<div class="mt-2 space-y-3" data-testid="contact-verify-panel">
		<p class="text-xs text-text-secondary max-w-prose">
			{{ t('components.postbox.postboxContactVerifyPanel.intro', { address }) }}
		</p>

		<div class="flex flex-wrap items-start gap-4">
			<!-- palette-ok: a QR code is read by a camera, not by a person. Scanners
			     expect dark modules on a light field with a light quiet zone; drawing
			     it on a themed surface — never mind a dark one — is how a code stops
			     scanning. The literal white IS the contract here. -->
			<div class="shrink-0 rounded border border-border-subtle bg-white p-1.5">
				<PostboxQrCode
					:value="qrValue"
					:size="132"
					:label="t('components.postbox.postboxContactVerifyPanel.qrLabel', { address })"
				/>
			</div>

			<div class="min-w-0 flex-1 space-y-2.5">
				<div>
					<p class="text-xs text-text-tertiary">
						{{ t('components.postbox.postboxContactVerifyPanel.writtenLabel') }}
					</p>
					<p
						class="font-mono text-xs text-text-secondary break-all select-all"
						data-testid="verify-fingerprint"
					>
						{{ grouped }}
					</p>
				</div>

				<div v-if="spokenLines.length > 0">
					<p class="text-xs text-text-tertiary">
						{{ t('components.postbox.postboxContactVerifyPanel.spokenLabel') }}
					</p>
					<p
						v-for="(line, index) in spokenLines"
						:key="index"
						class="font-mono text-xs text-text-secondary tabular-nums select-all"
						data-testid="verify-spoken-line"
					>
						{{ line }}
					</p>
				</div>
			</div>
		</div>

		<p v-if="errored" class="text-xs text-error" data-testid="verify-error">
			{{ t('components.postbox.postboxContactVerifyPanel.error') }}
		</p>

		<div class="flex flex-wrap items-center gap-2">
			<UiButton
				v-if="state !== 'verified'"
				size="sm"
				type="button"
				data-testid="verify-confirm"
				:disabled="setVerified.isLoading.value"
				@click="submit(true)"
			>
				{{ t('components.postbox.postboxContactVerifyPanel.confirm') }}
			</UiButton>
			<UiButton
				v-if="state !== 'unverified'"
				size="sm"
				variant="secondary"
				type="button"
				data-testid="verify-withdraw"
				:disabled="setVerified.isLoading.value"
				@click="submit(false)"
			>
				{{ t('components.postbox.postboxContactVerifyPanel.withdraw') }}
			</UiButton>
		</div>
		<!-- Said next to the button, not in a tooltip: someone about to make this
		     claim should see what it does and does not mean while they make it. -->
		<p class="text-xs text-text-tertiary max-w-prose">
			{{ t('components.postbox.postboxContactVerifyPanel.caveat') }}
		</p>
	</div>
</template>
