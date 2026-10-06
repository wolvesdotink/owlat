<script setup lang="ts">
/**
 * The composer's pre-send warning surfaces, both in one component so
 * PostboxComposer only mounts one thing and the WARNING BUDGET is visible in a
 * single file:
 *
 *   • a themed replay-confirm dialog for a send that will fail DMARC (idea 3);
 *   • a themed replay-confirm dialog for the missing attachment (idea 15) —
 *     this is what replaced the native `window.confirm`.
 *
 * A first-time recipient (idea 5) is only a cue on its chip, never a gate.
 *
 * Presentational: the decisions live in `usePostboxComposerGuards`, which owns
 * the ask-once state and replays the parked send. This file only renders the
 * facade and calls back into it.
 */
import type { ComposerGuards } from '~/composables/postbox/usePostboxComposerGuards';

const props = defineProps<{ guards: ComposerGuards }>();

const { t } = useI18n();

/**
 * The alignment verdict arrives as catalog keys (or, for a transport's own
 * worded reason, as the sentence itself) — same render-boundary resolution the
 * From-picker's chip does.
 */
const alignmentDescription = computed(() => {
	const detail = props.guards.alignmentWarning?.detail;
	return detail ? t(detail) : t('components.postbox.postboxComposerGuards.alignment.fallback');
});

const attachmentCopy = computed(() => {
	const hint = props.guards.attachmentHint;
	const kind = hint?.kind === 'forwardedQuote' ? 'forward' : 'mention';
	return {
		title: t(`components.postbox.postboxComposerGuards.attachment.${kind}Title`),
		description: t(`components.postbox.postboxComposerGuards.attachment.${kind}Description`, {
			phrase: hint?.phrase ?? '',
		}),
	};
});

</script>

<template>
	<div>
		<!-- Idea 3: the identity is unverified or misaligned, so this send is a
		     known rejection. A warning, never a block — self-hosters mid-setup
		     must still be able to send. -->
		<UiConfirmationDialog
			:open="guards.alignment.open"
			variant="warning"
			:title="t('components.postbox.postboxComposerGuards.alignment.title')"
			:description="alignmentDescription"
			:confirm-text="t('components.postbox.postboxComposerGuards.sendAnyway')"
			:cancel-text="t('components.postbox.postboxComposerGuards.keepEditing')"
			@update:open="guards.alignment.setOpen($event)"
			@confirm="guards.alignment.confirm()"
		/>

		<!-- Idea 15: the draft claims an attachment it does not carry (or forwards
		     one that was dropped). Quotes the phrase back so the warning can be
		     judged instead of reflexively confirmed. -->
		<UiConfirmationDialog
			:open="guards.attachment.open"
			variant="warning"
			:title="attachmentCopy.title"
			:description="attachmentCopy.description"
			:confirm-text="t('components.postbox.postboxComposerGuards.sendAnyway')"
			:cancel-text="t('components.postbox.postboxComposerGuards.keepEditing')"
			@update:open="guards.attachment.setOpen($event)"
			@confirm="guards.attachment.confirm()"
		/>
	</div>
</template>
