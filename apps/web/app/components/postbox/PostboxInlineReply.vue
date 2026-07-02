<script setup lang="ts">
/**
 * Spark-style inline reply box pinned under the conversation.
 *
 * Collapsed: a one-line "Reply to <sender>…" affordance (+ Reply-all/Forward
 * icons). Expanded: the REAL composer (PostboxComposer in its inline variant)
 * seeded by the reader — so autosave / undo-send / signatures / quoted text
 * behave exactly like the popup path. The header's expand button promotes the
 * draft to a normal popup with the SAME draft id (no content loss).
 *
 * The box never expands on its own: it mounts collapsed on thread open (so it
 * can't steal focus) and collapses back after send/discard.
 */
import type {
	ComposerPromotePayload,
	InlineComposeKind,
	InlineComposeSpec,
} from '~/composables/postbox/usePostboxComposerStack';

const props = defineProps<{
	/** Display name/address a plain Reply goes to (collapsed-line copy). */
	senderLabel: string;
	/** Whether Reply-All would add anyone beyond a plain Reply. */
	showReplyAll: boolean;
	/** Expanded composer seed; null renders the collapsed affordance. */
	spec: InlineComposeSpec | null;
}>();

const emit = defineEmits<{
	(e: 'expand', kind: InlineComposeKind): void;
	(e: 'collapse'): void;
}>();

const stack = usePostboxComposerStack();
const undoSend = usePostboxUndoSend();

const rootEl = ref<HTMLElement | null>(null);
const composerRef = ref<{ focusBody: () => void } | null>(null);

// Auto-scroll the box into view when it expands — it sits at the bottom of a
// potentially long thread. Optional-chained: test DOMs may lack the method.
watch(
	() => props.spec,
	(spec) => {
		if (!spec) return;
		void nextTick(() => {
			rootEl.value?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
		});
	}
);

function onSent(undoToken: string, sendAt: number) {
	const spec = props.spec;
	if (spec) undoSend.arm({ undoToken, sendAt, mailboxId: spec.mailboxId });
	emit('collapse');
}

/**
 * Promote the inline draft to a normal popup composer. The composer flushed
 * autosave before emitting, so `payload.draftId` is the live draft row — the
 * popup reopens it (same id) seeded with the current field values.
 */
function onPromote(payload: ComposerPromotePayload) {
	const spec = props.spec;
	if (!spec) return;
	stack.open({
		mailboxId: spec.mailboxId,
		...(payload.draftId ? { draftId: payload.draftId } : {}),
		...(spec.inReplyToMessageId ? { inReplyToMessageId: spec.inReplyToMessageId } : {}),
		prefillTo: payload.toAddresses,
		prefillCc: payload.ccAddresses,
		prefillBcc: payload.bccAddresses,
		prefillSubject: payload.subject,
		prefillBodyHtml: payload.bodyHtml,
	});
	emit('collapse');
}

defineExpose({
	/** Focus the inline body editor (r/a re-press while already open). */
	focusEditor: () => composerRef.value?.focusBody(),
});
</script>

<template>
	<div ref="rootEl">
		<!-- Collapsed one-line affordance -->
		<div
			v-if="!spec"
			class="flex items-center gap-1 rounded border border-border-subtle bg-bg-surface px-2 py-1.5"
		>
			<button
				type="button"
				class="flex-1 min-w-0 flex items-center gap-2 px-1.5 py-1 rounded text-left text-sm text-text-tertiary hover:text-text-primary hover:bg-bg-elevated"
				@click="emit('expand', 'reply')"
			>
				<Icon name="lucide:reply" class="w-4 h-4 flex-shrink-0" />
				<span class="truncate">Reply to {{ senderLabel }}…</span>
			</button>
			<button
				v-if="showReplyAll"
				type="button"
				class="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-elevated"
				title="Reply all"
				aria-label="Reply all"
				@click="emit('expand', 'replyAll')"
			>
				<Icon name="lucide:reply-all" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-elevated"
				title="Forward"
				aria-label="Forward"
				@click="emit('expand', 'forward')"
			>
				<Icon name="lucide:forward" class="w-4 h-4" />
			</button>
		</div>

		<!-- Expanded inline composer. role="dialog" both for a11y and so the
		     reader's single-key shortcut handler defers to the composer (same
		     [role="dialog"] guard as the popup): focus on a non-editable control
		     here must never let e/# archive the thread being replied to. -->
		<div
			v-else
			:key="spec.key"
			role="dialog"
			aria-label="Inline reply"
			class="h-[380px] flex flex-col overflow-hidden rounded border border-border-subtle bg-bg-elevated shadow-sm"
		>
			<PostboxComposer
				ref="composerRef"
				inline
				:mailbox-id="spec.mailboxId"
				:draft-id="spec.draftId"
				:in-reply-to-message-id="spec.inReplyToMessageId"
				:prefill-to="spec.prefillTo"
				:prefill-cc="spec.prefillCc"
				:prefill-bcc="spec.prefillBcc"
				:prefill-subject="spec.prefillSubject"
				:prefill-body-html="spec.prefillBodyHtml"
				:forward-attachments-from-message-id="spec.forwardAttachmentsFromMessageId"
				@sent="onSent"
				@discarded="emit('collapse')"
				@minimize="emit('collapse')"
				@promote="onPromote"
			/>
		</div>
	</div>
</template>
