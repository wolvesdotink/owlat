<script setup lang="ts">
import { extractClearsignedText, type SecureMessageClass } from '@owlat/shared/secureMessage';
import { computeSecureMessageRecovery } from '~/composables/postbox/useSecureMessageRecovery';

/**
 * Honest PGP/S-MIME disclosure for the reader. Owlat doesn't verify signatures
 * or decrypt bodies yet, so this states the structure plainly ("Signed — not
 * verified" / "Encrypted") rather than implying a cryptographic guarantee.
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
}>();

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
	<div v-if="meta" class="mt-2">
		<div
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
			v-if="clearsignedText"
			class="mt-2 text-sm whitespace-pre-wrap font-sans text-text-primary"
		>{{ clearsignedText }}</pre>

		<!-- Encrypted: recovery controls so the user can decrypt externally. -->
		<div v-if="meta.encrypted" class="mt-2 flex flex-wrap items-center gap-2">
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
