<script setup lang="ts">
/**
 * The action row of an agent task card: ONE primary action, a non-destructive
 * skip/secondary, extra actions via the default slot (e.g. an "Edit" link),
 * and quiet keyboard hints. Actions always dispatch to the SAME callbacks the
 * consumer's buttons already used — this is presentation, never a new
 * action path.
 */
import { PencilIcon, type IconComponent } from '@coolicons/vue';
// Imported, not auto-registered: every card that mounts this row (and its
// tests) gets the shared button without registering it.
import UiButton from '@owlat/ui/components/ui/Button.vue';

withDefaults(
	defineProps<{
		primaryLabel: string;
		primaryIcon?: IconComponent;
		primaryDisabled?: boolean;
		/** Shows a spinner in place of the icon while the action runs. */
		primaryLoading?: boolean;
		primaryTestId?: string;
		/** Omit to render no skip control. */
		skipLabel?: string;
		skipDisabled?: boolean;
		skipTestId?: string;
		/** Destructive skip (Reject/Dismiss) reads in the error tone. */
		skipDestructive?: boolean;
		/**
		 * Soft-hold: a teammate is actively replying to this thread, so the primary
		 * action is HELD — disabled-styled but visible, with {@link heldReason} shown
		 * beneath. Releases on its own when their presence drops.
		 */
		held?: boolean;
		/** Plain-language reason shown under the row while `held`. */
		heldReason?: string;
		/** The reason's element id, for a field it describes (`aria-describedby`). */
		heldReasonId?: string;
		/**
		 * Render the primary as a secondary button — when the card already offers
		 * a stronger next step (a prepared draft's "Review & send"), one accent.
		 */
		quiet?: boolean;
		/** Quiet keyboard hints, e.g. [{ keys: ['Enter'], label: 'Answer' }]. */
		hints?: ReadonlyArray<{ keys: readonly string[]; label: string }>;
	}>(),
	{
		primaryIcon: undefined,
		primaryDisabled: false,
		primaryLoading: false,
		primaryTestId: 'task-primary',
		skipLabel: undefined,
		skipDisabled: false,
		skipTestId: 'task-skip',
		skipDestructive: false,
		held: false,
		heldReason: undefined,
		heldReasonId: undefined,
		hints: undefined,
		quiet: false,
	}
);

const emit = defineEmits<{ (e: 'primary'): void; (e: 'skip'): void }>();
</script>

<template>
	<div class="flex flex-col gap-1.5" data-testid="task-actions">
		<div class="flex flex-wrap items-center gap-2">
			<UiButton
				:data-testid="primaryTestId"
				size="sm"
				:variant="quiet ? 'secondary' : 'primary'"
				class="gap-1.5"
				:disabled="primaryDisabled || held"
				:loading="primaryLoading"
				:aria-disabled="held ? 'true' : undefined"
				:aria-describedby="held && heldReason && heldReasonId ? heldReasonId : undefined"
				@click.stop.prevent="emit('primary')"
			>
				<component
					:is="primaryIcon"
					v-if="primaryIcon && !primaryLoading"
					class="w-3.5 h-3.5"
					aria-hidden="true"
				/>
				{{ primaryLabel }}
			</UiButton>
			<slot />
			<UiButton
				v-if="skipLabel"
				:data-testid="skipTestId"
				size="sm"
				:variant="skipDestructive ? 'danger-ghost' : 'ghost'"
				:disabled="skipDisabled"
				@click.stop.prevent="emit('skip')"
			>
				{{ skipLabel }}
			</UiButton>
			<span
				v-if="hints?.length"
				class="ml-auto hidden sm:flex items-center gap-x-3 text-2xs text-text-tertiary"
				aria-hidden="true"
			>
				<span v-for="hint in hints" :key="hint.label" class="inline-flex items-center gap-1">
					<kbd
						v-for="k in hint.keys"
						:key="k"
						class="px-1 py-px rounded border border-border-subtle bg-bg-surface font-mono text-2xs text-text-secondary"
						>{{ k }}</kbd
					>
					<span>{{ hint.label }}</span>
				</span>
			</span>
		</div>

		<!-- Why the primary action is held: a teammate is replying, or the draft still has gaps. -->
		<p
			v-if="held && heldReason"
			:id="heldReasonId"
			class="inline-flex items-center gap-1.5 text-2xs text-text-tertiary"
			data-testid="task-held-reason"
			role="status"
		>
			<PencilIcon class="w-3 h-3 text-warning shrink-0" aria-hidden="true" />
			<span>{{ heldReason }}</span>
		</p>
	</div>
</template>
