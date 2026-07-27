<script setup lang="ts">
/**
 * Inline answer to "why is this contact not getting mail?" — shown at the top of
 * the contact profile when the address is on the suppression list. One
 * warning-subtle line that explains the reason in plain language and, for anyone
 * who can manage contacts, offers the one-click way out (remove the suppression).
 *
 * Presentational only: the profile page owns the query + mutation and passes the
 * reason, a human date label, and the permission flag in. The action is gated on
 * `canManage` here for affordance; the backend re-checks `contacts:manage`.
 */
import { type BlockReason, suppressionReasonPresentation } from '~/utils/suppressionReasons';

const props = defineProps<{
	reason: BlockReason;
	/** Pre-formatted human date the address was suppressed (e.g. "Mar 3"). */
	dateLabel: string;
	/** Whether the viewer may remove suppressions (contacts:manage). */
	canManage: boolean;
	/** Removal in flight. */
	removing?: boolean;
}>();

const emit = defineEmits<{ remove: [] }>();

// Plain language, reason-specific — no jargon, explains WHY in one line. The
// wording comes from the SAME table the suppression list renders from, so the
// two surfaces cannot describe the same reason differently, and a new schema
// literal is a compile error rather than a silent "manually suppressed".
const reasonPhrase = computed(() =>
	suppressionReasonPresentation(props.reason).phrase(props.dateLabel)
);
</script>

<template>
	<div
		class="flex items-center gap-2.5 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-sm"
		role="status"
	>
		<Icon name="lucide:mail-x" class="w-4 h-4 shrink-0 text-warning" />
		<p class="text-text-secondary">
			<span class="font-medium text-text-primary">Not receiving mail</span>
			— {{ reasonPhrase }}.
			<button
				v-if="canManage"
				type="button"
				class="-my-2 -mx-1 px-1 py-2 font-medium text-brand hover:underline disabled:opacity-60"
				:disabled="removing"
				@click="emit('remove')"
			>
				{{ removing ? 'Removing…' : 'Remove suppression?' }}
			</button>
		</p>
	</div>
</template>
