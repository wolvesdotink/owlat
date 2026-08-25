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
import { shortFingerprint } from '~/utils/fingerprints';

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

const { t } = useI18n();

const reaccept = useBackendOperation(api.e2ee.recipientKeys.reacceptKeyChange, {
	label: () => t('components.postbox.postboxKeyChangeBanner.acceptOperation'),
});

// Re-pinning a changed key is an `adminMutation` (E2): only owners/admins can
// re-accept. Members see the same honest warning but are told to ask an admin,
// rather than a button that would always fail with a misleading error.
const { isAdmin } = usePermissions();

const errored = ref(false);

const oldShort = computed(() => shortFingerprint(props.oldFingerprint));
const newShort = computed(() => shortFingerprint(props.newFingerprint));

async function accept() {
	errored.value = false;
	const result = await reaccept.run({ address: props.address });
	if (result.ok && result.result.reaccepted) {
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
				<p class="text-sm text-text-primary font-medium">
					{{ t('components.postbox.postboxKeyChangeBanner.title') }}
				</p>
				<p class="mt-1 text-xs text-text-secondary max-w-prose">
					{{ t('components.postbox.postboxKeyChangeBanner.body', { address }) }}
				</p>
				<dl v-if="oldShort || newShort" class="mt-1.5 text-xs text-text-tertiary space-y-0.5">
					<div v-if="oldShort" class="flex gap-2">
						<dt class="w-20 flex-shrink-0">
							{{ t('components.postbox.postboxKeyChangeBanner.previousKey') }}
						</dt>
						<dd class="font-mono">{{ oldShort }}</dd>
					</div>
					<div v-if="newShort" class="flex gap-2">
						<dt class="w-20 flex-shrink-0">
							{{ t('components.postbox.postboxKeyChangeBanner.newKey') }}
						</dt>
						<dd class="font-mono">{{ newShort }}</dd>
					</div>
				</dl>
				<p v-if="errored" class="mt-1.5 text-xs text-error" data-testid="key-change-error">
					{{ t('components.postbox.postboxKeyChangeBanner.error') }}
				</p>
				<div v-if="isAdmin" class="mt-2 flex items-center gap-2">
					<UiButton
						size="sm"
						type="button"
						data-testid="key-change-accept"
						:disabled="reaccept.isLoading.value"
						@click="accept"
					>
						{{
							reaccept.isLoading.value
								? t('components.postbox.postboxKeyChangeBanner.accepting')
								: t('components.postbox.postboxKeyChangeBanner.accept')
						}}
					</UiButton>
				</div>
				<p v-else class="mt-2 text-xs text-text-secondary" data-testid="key-change-admin-only">
					{{ t('components.postbox.postboxKeyChangeBanner.adminOnly') }}
				</p>
			</div>
		</div>
	</div>
</template>
