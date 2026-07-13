<script setup lang="ts">
import { extractClearsignedText, type SecureMessageClass } from '@owlat/shared/secureMessage';
import { computeSecureMessageRecovery } from '~/composables/postbox/useSecureMessageRecovery';
import { deriveSealedBadge, type InboundEncryptionInfo } from '~/utils/sealedMessage';
import { SEAL_TONE_CLASSES } from '~/utils/sealTone';

/**
 * Honest PGP/S-MIME disclosure for the reader.
 *
 * Two drivers, in priority order:
 *   1. `sealed` (Sealed Mail E5, flag `sealedMail`) — the honest inbound sealing
 *      record from decrypt-on-ingest (`mailMessages.inboundEncryptionInfo`). When
 *      present it wins: a decrypted-and-verified message reads "Sealed — sender
 *      verified", a decrypted-but-unverified one "Sealed — sender not verified",
 *      and an undecryptable one "Encrypted — can't decrypt". Every string is
 *      derived by `deriveSealedBadge`, whose honesty audit is a unit test —
 *      "verified" is unreachable without a valid signature against the pinned key.
 *   2. `klass` (structural PGP/S-MIME detection) — the pre-Sealed-Mail fallback
 *      for messages we never opened: states the structure plainly ("Signed — not
 *      verified" / "Encrypted") rather than implying a cryptographic guarantee.
 *
 * For an encrypted body the reader hides the (unreadable) content, so this badge
 * also offers an escape hatch — copy the ciphertext / download the raw .eml — so
 * the user can decrypt it in an external OpenPGP tool. Without it an inline
 * ("armored") encrypted message, whose ciphertext lives in the body rather than
 * a downloadable PGP/MIME part, would strand the user with no way to recover it.
 */
const props = defineProps<{
	klass: SecureMessageClass;
	message: { _id?: string; textBodyInline?: string };
	/**
	 * Sealed Mail (E5): the inbound sealing record. Present only on a message that
	 * arrived sealed between Owlat instances; absent for ordinary (plaintext or
	 * external-PGP) mail, where the `klass` driver takes over.
	 */
	sealed?: InboundEncryptionInfo;
}>();

// Sealed-Mail badge (priority driver). Null for a message with no sealing record.
const sealedBadge = computed(() => deriveSealedBadge(props.sealed));

const clearsignedText = computed(() =>
	props.klass === 'pgp-clearsigned' && props.message.textBodyInline
		? extractClearsignedText(props.message.textBodyInline)
		: null
);

const meta = computed(() => {
	switch (props.klass) {
		case 'pgp-encrypted':
			return { icon: 'lucide:lock', label: 'Encrypted (PGP)', encrypted: true };
		case 'smime-encrypted':
			return { icon: 'lucide:lock', label: 'Encrypted (S/MIME)', encrypted: true };
		case 'pgp-signed':
		case 'pgp-clearsigned':
			return { icon: 'lucide:pen-tool', label: 'Signed (PGP)', encrypted: false };
		case 'smime-signed':
			return { icon: 'lucide:pen-tool', label: 'Signed (S/MIME)', encrypted: false };
		default:
			return null;
	}
});

const tooltip = computed(() =>
	meta.value?.encrypted
		? "Owlat can't decrypt this message — the encrypted content is shown as-is."
		: 'A cryptographic signature is present but is not verified by Owlat.'
);

// Recovery model: the inline ("armored") ciphertext block, if the encrypted
// body carries one. PGP/MIME messages keep the ciphertext in a downloadable
// octet-stream part instead, so this is null for them — they recover via the
// reader's attachment row.
const recovery = computed(() =>
	computeSecureMessageRecovery(props.klass, props.message.textBodyInline)
);
const armoredCiphertext = computed(() => recovery.value.armoredCiphertext);

// Sealed-Mail chip tone classes (FF tokens only) — shared with the composer
// seal-lock so chip and icon never drift apart between the two surfaces.
const sealedTone = computed(() =>
	sealedBadge.value ? SEAL_TONE_CLASSES[sealedBadge.value.tone] : SEAL_TONE_CLASSES.warn
);

// Recovery controls appear for any undecryptable ciphertext — the Sealed-Mail
// "can't decrypt" state OR the structural encrypted `klass` (when no sealing
// record drives the badge). A decrypted sealed message needs no recovery.
const showRecovery = computed(
	() => sealedBadge.value?.state === 'cantDecrypt' || (!sealedBadge.value && meta.value?.encrypted)
);

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
onUnmounted(() => clearTimeout(copiedTimer));

async function copyCiphertext() {
	const text = armoredCiphertext.value;
	if (!text) return;
	try {
		await navigator.clipboard?.writeText(text);
		copied.value = true;
		clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => (copied.value = false), 2000);
	} catch {
		// Clipboard denied — the download path remains as a fallback.
	}
}

const downloadingEml = ref(false);

/**
 * Download the raw .eml so the user can decrypt it externally. Prefers the
 * server-side raw blob (carries headers + every part); falls back to the inline
 * armored ciphertext when the raw blob is unavailable, so there is always a
 * recovery path.
 */
async function downloadRawEml() {
	if (!props.message._id) return saveBlob(armoredCiphertext.value ?? '', 'message.asc');
	downloadingEml.value = true;
	try {
		const bin = await loadRawEml(props.message._id);
		if (bin) {
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
			saveBlob(bytes, 'message.eml');
		} else {
			saveBlob(armoredCiphertext.value ?? '', 'message.asc');
		}
	} catch {
		saveBlob(armoredCiphertext.value ?? '', 'message.asc');
	} finally {
		downloadingEml.value = false;
	}
}

function saveBlob(data: string | Uint8Array, filename: string) {
	if (typeof data === 'string' && data.length === 0) return;
	const blob = new Blob([data as BlobPart], { type: 'application/octet-stream' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 30000);
}
</script>

<template>
	<div v-if="sealedBadge || meta" class="mt-2">
		<!-- Sealed-Mail chip (priority driver): the honest inbound sealing record. -->
		<div v-if="sealedBadge" data-testid="sealed-badge">
			<div
				class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border"
				:class="sealedTone.chip"
			>
				<Icon :name="sealedBadge.icon" class="w-3.5 h-3.5" :class="sealedTone.icon" />
				<span data-testid="sealed-badge-summary">{{ sealedBadge.summary }}</span>
			</div>
			<p class="mt-1.5 text-xs text-text-secondary max-w-prose" data-testid="sealed-badge-detail">
				{{ sealedBadge.detail }}
			</p>
		</div>

		<!-- Structural PGP/S-MIME chip (fallback): only when no sealing record drives it. -->
		<div
			v-else-if="meta"
			class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border border-border-subtle text-text-secondary"
			:title="tooltip"
		>
			<Icon
				:name="meta.icon"
				class="w-3.5 h-3.5"
				:class="meta.encrypted ? 'text-brand' : 'text-text-tertiary'"
			/>
			{{ meta.label }}
			<span v-if="meta.encrypted" class="text-text-tertiary">· can't decrypt</span>
			<span v-else class="text-text-tertiary">· not verified</span>
		</div>

		<!-- Clearsigned: show the readable cleartext (signature is not verified). -->
		<pre
			v-if="clearsignedText && !sealedBadge"
			class="mt-2 text-sm whitespace-pre-wrap font-sans text-text-primary"
			>{{ clearsignedText }}</pre
		>

		<!-- Encrypted: recovery controls so the user can decrypt externally. -->
		<div v-if="showRecovery" class="mt-2 flex flex-wrap items-center gap-2">
			<button
				v-if="armoredCiphertext"
				type="button"
				class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border border-border-subtle text-text-secondary hover:bg-bg-elevated"
				data-testid="copy-ciphertext"
				@click="copyCiphertext"
			>
				<Icon
					:name="copied ? 'lucide:check' : 'lucide:copy'"
					class="w-3.5 h-3.5 text-text-tertiary"
				/>
				{{ copied ? 'Copied' : 'Copy encrypted message' }}
			</button>
			<button
				type="button"
				class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border border-border-subtle text-text-secondary hover:bg-bg-elevated disabled:opacity-50"
				data-testid="download-eml"
				:disabled="downloadingEml"
				@click="downloadRawEml"
			>
				<Icon
					:name="downloadingEml ? 'lucide:loader-2' : 'lucide:download'"
					class="w-3.5 h-3.5 text-text-tertiary"
					:class="{ 'animate-spin': downloadingEml }"
				/>
				Download raw .eml
			</button>
		</div>
	</div>
</template>
