<script setup lang="ts">
/**
 * Composer seal-lock indicator (Sealed Mail E5, flag `sealedMail`). Renders the
 * honest per-draft lock state derived by `deriveComposerLock`:
 *   - checking    — the seal state is still being computed for this draft; said
 *                   out loud so the compose surface is never silent about
 *                   sealing (muted);
 *   - willSeal    — Owlat will encrypt this message before it leaves (ok tone);
 *   - keyChanged  — a recipient's key rotated and must be re-confirmed in the
 *                   conversation's key-change banner (warn); the lock's copy
 *                   points the reader there — re-accepting lives on the thread,
 *                   not the composer;
 *   - cannotSeal  — the message would go out unsealed, WITH the plain-language
 *                   reason, and a "Send unsealed…" control that opens the
 *                   proceed-or-cancel prompt (never a silent plaintext send).
 *
 * The unsealed control REQUESTS the decision, it does not take it: the parent
 * owns the confirm dialog, so the same prompt covers this control, the Send
 * button and the send shortcut.
 *
 * Every string it renders comes from the pure derivation, whose honesty audit is
 * a unit test. When the flag is off the parent passes `enabled=false` and the
 * lock renders nothing.
 */
import { deriveComposerLock, type SealState } from '~/utils/sealComposer';
import { SEAL_TONE_CLASSES } from '~/utils/sealTone';

const props = withDefaults(
	defineProps<{
		/** Feature-flag gate: when false the lock renders nothing. */
		enabled: boolean;
		/** The draft's seal state from `api.mail.drafts.getComposerSealState`. */
		sealState: SealState | null;
		/** The state query is in flight for this draft — render the checking lock. */
		pending?: boolean;
	}>(),
	{ pending: false }
);

const emit = defineEmits<{
	/** cannotSeal only: the reader wants to decide about sending unsealed. */
	'request-unsealed': [];
}>();

const { t } = useI18n();

/** The lock derivation hands back message keys (parameterized ones as `{ key, params }`). */
const localize = (value: string | { key: string; params?: Record<string, unknown> }): string =>
	typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});

// Nothing to say only before a draft exists (no query yet): from the moment the
// state is being computed the lock speaks, first as `checking`.
const lock = computed(() =>
	props.enabled && (props.sealState || props.pending) ? deriveComposerLock(props.sealState) : null
);

// FF-token chip/icon classes, shared with the reader's sealed badge.
const toneClasses = computed(() =>
	lock.value ? SEAL_TONE_CLASSES[lock.value.tone] : SEAL_TONE_CLASSES.muted
);
</script>

<template>
	<!-- Owns its own horizontal padding: the composer renders it unwrapped so the
	     flag-off / nothing-to-say case leaves no empty row. -->
	<div v-if="lock" class="mt-2 px-3" data-testid="seal-lock">
		<div
			class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border"
			:class="toneClasses.chip"
		>
			<Icon
				:name="lock.icon"
				class="w-3.5 h-3.5"
				:class="[toneClasses.icon, lock.kind === 'checking' && 'animate-spin']"
			/>
			<span data-testid="seal-lock-summary">{{ localize(lock.summary) }}</span>
		</div>
		<p class="mt-1.5 text-xs text-text-secondary max-w-prose" data-testid="seal-lock-detail">
			{{ localize(lock.detail) }}
		</p>
		<div v-if="lock.allowSendUnsealed" class="mt-1.5 flex flex-wrap items-center gap-2">
			<button
				type="button"
				class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border border-border-subtle text-text-secondary hover:bg-bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
				data-testid="seal-lock-send-unsealed"
				@click="emit('request-unsealed')"
			>
				{{ t('components.postbox.postboxComposerSealLock.sendUnsealed') }}
			</button>
		</div>
	</div>
</template>
