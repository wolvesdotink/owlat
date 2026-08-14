<script setup lang="ts">
/**
 * Unsealed-send decision (Sealed Mail E5). When a draft can't be sealed, sending
 * it anyway is a choice the sender makes here — the reason and what plaintext
 * delivery means, then proceed or cancel. Every path that could downgrade a send
 * (the Send button, the send shortcut, the scheduler, the lock's "Send unsealed…"
 * control) routes through this ONE dialog, so no message ever goes out unsealed
 * on a footnote.
 *
 * The copy is derived (`deriveUnsealedPrompt`), not written here: a state with no
 * prompt — willSeal, keyChanged, or a draft with no recipients yet — is not the
 * sender's to override, and the dialog stays shut.
 */
import { deriveUnsealedPrompt, type SealState } from '~/utils/sealComposer';

const props = defineProps<{
	open: boolean;
	/** The draft's seal state; supplies the reason shown in the prompt. */
	sealState: SealState | null;
}>();

const emit = defineEmits<{
	'update:open': [value: boolean];
	confirm: [];
}>();

const { t } = useI18n();

const prompt = computed(() => deriveUnsealedPrompt(props.sealState));

/** The derivation hands back message keys (parameterized ones as `{ key, params }`). */
const localize = (value: string | { key: string; params?: Record<string, unknown> }): string =>
	typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
</script>

<template>
	<UiConfirmationDialog
		v-if="prompt"
		:open="open"
		variant="warning"
		:title="localize(prompt.title)"
		:description="localize(prompt.description)"
		:confirm-text="localize(prompt.confirmLabel)"
		:cancel-text="localize(prompt.cancelLabel)"
		@update:open="emit('update:open', $event)"
		@confirm="emit('confirm')"
	/>
</template>
