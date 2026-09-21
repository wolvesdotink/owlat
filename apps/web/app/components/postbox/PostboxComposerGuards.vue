<script setup lang="ts">
/**
 * The composer's pre-send warning surfaces, all three in one component so
 * PostboxComposer only mounts one thing and the WARNING BUDGET is visible in a
 * single file:
 *
 *   • a themed replay-confirm dialog for a send that will fail DMARC (idea 3);
 *   • a themed replay-confirm dialog for the missing attachment (idea 15) —
 *     this is what replaced the native `window.confirm`;
 *   • a ONE-LINE inline confirm for first-time recipients (idea 5), which is a
 *     caution, not an irreversible mistake, and so never earns a modal.
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

const firstTimeNames = computed(() => props.guards.firstTimeAddresses.join(', '));
</script>

<template>
	<div>
		<!-- Idea 5: a stranger among the recipients. One line, dismissible, sitting
		     with the recipient fields it is about — deliberately NOT a modal. -->
		<div
			v-if="guards.firstTime.open"
			class="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border-subtle bg-bg-surface text-xs"
			data-testid="postbox-first-time-confirm"
		>
			<Icon name="lucide:user-plus" class="w-3.5 h-3.5 shrink-0 text-warning" />
			<span class="text-text-secondary">
				{{
					t(
						'components.postbox.postboxComposerGuards.firstTime.body',
						{ addresses: firstTimeNames },
						guards.firstTimeAddresses.length
					)
				}}
			</span>
			<button
				type="button"
				class="text-brand hover:underline"
				@click="guards.firstTime.confirm()"
			>
				{{ t('components.postbox.postboxComposerGuards.firstTime.send') }}
			</button>
			<button
				type="button"
				class="text-text-tertiary hover:text-text-primary"
				@click="guards.firstTime.dismiss()"
			>
				{{ t('components.postbox.postboxComposerGuards.firstTime.keepEditing') }}
			</button>
		</div>

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
