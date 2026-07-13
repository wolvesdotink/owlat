<script setup lang="ts">
/**
 * Key-change thread banner (Sealed Mail E5, flag `sealedMail`). Signal-style: a
 * recipient's sealing key changed WITHOUT a signed rotation statement, so Owlat
 * kept the old pin and stopped sealing to them. We never silently adopt the new
 * key — the reader must EXPLICITLY accept it, which re-pins via the E2 admin
 * mutation `api.e2ee.recipientKeys.reacceptKeyChange`.
 *
 * Honest by construction: the banner shows only for a real `keyChanged` state
 * (the parent decides), states plainly what happened, and never seals to the new
 * key until the human accepts. On success it emits `accepted` so the host can
 * re-check the seal state.
 */
import { api } from '@owlat/api';

const props = defineProps<{
	/** The recipient whose key changed (drives the copy and the re-pin call). */
	address: string;
	/** The previously trusted fingerprint (may be absent on a legacy row). */
	oldFingerprint?: string | null;
	/** The newly observed fingerprint awaiting acceptance. */
	newFingerprint?: string | null;
}>();

const emit = defineEmits<{
	/** The reader re-accepted the new key (re-pin succeeded). */
	accepted: [];
}>();

const reaccept = useBackendOperation(api.e2ee.recipientKeys.reacceptKeyChange, {
	label: 'accept-recipient-key',
});

const errored = ref(false);

/** Short, human display of a fingerprint (last 16 hex chars, spaced). */
function shortFingerprint(fp: string | null | undefined): string | null {
	if (!fp) return null;
	const clean = fp.replace(/\s+/g, '').toUpperCase();
	const tail = clean.slice(-16);
	return tail.replace(/(.{4})/g, '$1 ').trim();
}

const oldShort = computed(() => shortFingerprint(props.oldFingerprint));
const newShort = computed(() => shortFingerprint(props.newFingerprint));

async function accept() {
	errored.value = false;
	const result = (await reaccept.run({ address: props.address })) as
		| { reaccepted: boolean }
		| undefined;
	if (result?.reaccepted) {
		emit('accepted');
	} else {
		errored.value = true;
	}
}
</script>

<template>
	<div
		class="my-3 px-3 py-2.5 rounded border border-warning/40 bg-warning/10"
		data-testid="key-change-banner"
		role="status"
	>
		<div class="flex items-start gap-2.5">
			<Icon name="lucide:key-round" class="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
			<div class="min-w-0">
				<p class="text-sm text-text-primary font-medium">This person's sealing key changed</p>
				<p class="mt-1 text-xs text-text-secondary max-w-prose">
					The key Owlat uses to seal mail to {{ address }} is different from the one you trusted
					before. Until you confirm the new key, messages to them are sent normally instead of
					sealed. Only accept it if you were expecting this change.
				</p>
				<dl v-if="oldShort || newShort" class="mt-1.5 text-xs text-text-tertiary space-y-0.5">
					<div v-if="oldShort" class="flex gap-2">
						<dt class="w-20 flex-shrink-0">Previous key</dt>
						<dd class="font-mono">{{ oldShort }}</dd>
					</div>
					<div v-if="newShort" class="flex gap-2">
						<dt class="w-20 flex-shrink-0">New key</dt>
						<dd class="font-mono">{{ newShort }}</dd>
					</div>
				</dl>
				<p v-if="errored" class="mt-1.5 text-xs text-error" data-testid="key-change-error">
					Couldn't accept the new key. It may have already been resolved — try reopening this
					thread.
				</p>
				<div class="mt-2 flex items-center gap-2">
					<button
						type="button"
						class="btn btn-primary btn-sm"
						data-testid="key-change-accept"
						:disabled="reaccept.isLoading.value"
						@click="accept"
					>
						{{ reaccept.isLoading.value ? 'Accepting…' : 'Accept new key' }}
					</button>
				</div>
			</div>
		</div>
	</div>
</template>
