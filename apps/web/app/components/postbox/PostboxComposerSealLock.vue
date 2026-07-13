<script setup lang="ts">
/**
 * Composer seal-lock indicator (Sealed Mail E5, flag `sealedMail`). Renders the
 * honest per-draft lock state derived by `deriveComposerLock`:
 *   - willSeal    — Owlat will encrypt this message before it leaves (ok tone);
 *   - keyChanged  — a recipient's key rotated and must be re-confirmed (warn);
 *   - cannotSeal  — the message would go out unsealed, WITH the plain-language
 *                   reason, and an EXPLICIT "Send unsealed" control (never a
 *                   silent plaintext send).
 *
 * Every string it renders comes from the pure derivation, whose honesty audit is
 * a unit test. When the flag is off the parent passes `enabled=false` and the
 * lock renders nothing.
 */
import { deriveComposerLock, type SealLockTone, type SealState } from '~/utils/sealComposer';

const props = defineProps<{
	/** Feature-flag gate: when false the lock renders nothing. */
	enabled: boolean;
	/** The draft's seal state from `api.mail.drafts.getComposerSealState`. */
	sealState: SealState | null;
}>();

const emit = defineEmits<{
	/** cannotSeal only: the reader explicitly chose to send this message unsealed. */
	'send-unsealed': [];
	/** keyChanged only: open the key-change review (the reader wants to re-confirm). */
	'review-keys': [];
}>();

const lock = computed(() =>
	props.enabled && props.sealState ? deriveComposerLock(props.sealState) : null
);

// FF tokens only — one table keyed by the tone discriminator so chip and icon
// styling never drift apart.
const TONE_CLASSES: Record<SealLockTone, { chip: string; icon: string }> = {
	ok: { chip: 'border-success/40 text-success', icon: 'text-success' },
	warn: { chip: 'border-warning/40 text-warning', icon: 'text-warning' },
	muted: { chip: 'border-border-subtle text-text-secondary', icon: 'text-text-tertiary' },
};
const toneClasses = computed(() =>
	lock.value ? TONE_CLASSES[lock.value.tone] : TONE_CLASSES.muted
);
</script>

<template>
	<div v-if="lock" class="mt-2" data-testid="seal-lock">
		<div
			class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border"
			:class="toneClasses.chip"
		>
			<Icon :name="lock.icon" class="w-3.5 h-3.5" :class="toneClasses.icon" />
			<span data-testid="seal-lock-summary">{{ lock.summary }}</span>
		</div>
		<p class="mt-1.5 text-xs text-text-secondary max-w-prose" data-testid="seal-lock-detail">
			{{ lock.detail }}
		</p>
		<div class="mt-1.5 flex flex-wrap items-center gap-2">
			<button
				v-if="lock.kind === 'keyChanged'"
				type="button"
				class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border border-border-subtle text-text-secondary hover:bg-bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
				data-testid="seal-lock-review-keys"
				@click="emit('review-keys')"
			>
				Review the new key
			</button>
			<button
				v-if="lock.allowSendUnsealed"
				type="button"
				class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border border-border-subtle text-text-secondary hover:bg-bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
				data-testid="seal-lock-send-unsealed"
				@click="emit('send-unsealed')"
			>
				Send unsealed
			</button>
		</div>
	</div>
</template>
