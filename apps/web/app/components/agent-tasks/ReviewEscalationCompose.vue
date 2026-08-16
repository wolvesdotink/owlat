<script setup lang="ts">
/**
 * Inline reply composer for a draftless complaint/urgent escalation card in
 * the Review Queue: the agent pipeline skipped the drafter for these, so the
 * admin writes the reply here (persisted + sent through edit→approve by the
 * browse list). Includes the advisory coach panel, the grounding rationale and
 * the Send/Dismiss actions. Split out of ReviewBrowseList for the file-size
 * cap; all state stays with the parent via v-model.
 */
const body = defineModel<string>('body', { default: '' });
const subject = defineModel<string>('subject', { default: '' });

/** Mirrors InboxDecisionRationale's prop shape (the API's groundingSources). */
interface GroundingSource {
	type: 'thread' | 'knowledge';
	id: string;
	title: string;
}

defineProps<{
	aiEnabled: boolean;
	/** The inbound message text the coach panel grounds against. */
	threadContext?: string;
	groundingSources?: GroundingSource[] | null;
	/** Thread id for the "Open thread" escape hatch (absent on threadless mail). */
	threadId?: string;
	/** An action for this card is in flight — hold the buttons. */
	busy: boolean;
}>();

const emit = defineEmits<{ (e: 'send' | 'reject'): void }>();
</script>

<template>
	<div>
		<div class="bg-warning/5 border border-warning/20 rounded-lg p-4 mb-4">
			<div class="flex items-center gap-2 mb-3">
				<Icon name="lucide:user-round" class="w-4 h-4 text-warning" />
				<p class="text-xs font-medium text-warning uppercase tracking-wider">
					Escalated — write a reply
				</p>
			</div>
			<input
				v-model="subject"
				type="text"
				class="input w-full text-sm mb-3"
				placeholder="Subject (optional)"
			/>
			<textarea
				v-model="body"
				rows="6"
				class="input w-full text-sm resize-y"
				placeholder="Type your reply…"
			/>
			<!-- Coach the ADMIN's own reply before they send it. Advisory only — never rewrites the text. -->
			<PostboxCoachPanel :draft-text="body" :enabled="aiEnabled" :thread-context="threadContext" />
		</div>

		<!-- What the agent had to work from (the card's WHY line carries the escalation reason). -->
		<InboxDecisionRationale :grounding-sources="groundingSources" class="mb-4" />

		<!-- Actions -->
		<TaskActions
			primary-label="Send Reply"
			primary-icon="lucide:send"
			:primary-disabled="busy || !body.trim()"
			skip-label="Dismiss"
			skip-destructive
			:skip-disabled="busy"
			@primary="emit('send')"
			@skip="emit('reject')"
		>
			<NuxtLink
				v-if="threadId"
				:to="`/dashboard/inbox/${threadId}`"
				class="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
			>
				<Icon name="lucide:external-link" class="w-3 h-3" />
				Open thread
			</NuxtLink>
		</TaskActions>
	</div>
</template>
