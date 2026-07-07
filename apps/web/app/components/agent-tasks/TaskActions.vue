<script setup lang="ts">
/**
 * The action row of an agent task card: ONE primary action, a non-destructive
 * skip/secondary, extra actions via the default slot (e.g. an "Edit" link),
 * and quiet keyboard hints. Actions always dispatch to the SAME callbacks the
 * consumer's buttons already used — this is presentation, never a new
 * action path.
 */
withDefaults(
	defineProps<{
		primaryLabel: string;
		primaryIcon?: string;
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
		 * beneath. Releases on its own when their presence drops (see UX piece b3b).
		 */
		held?: boolean;
		/** Plain-language reason shown under the row while `held`. */
		heldReason?: string;
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
		hints: undefined,
	}
);

const emit = defineEmits<{ (e: 'primary'): void; (e: 'skip'): void }>();
</script>

<template>
	<div class="flex flex-col gap-1.5" data-testid="task-actions">
		<div class="flex flex-wrap items-center gap-2">
			<button
				type="button"
				:data-testid="primaryTestId"
				class="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded bg-brand text-white hover:bg-brand/90 transition-colors duration-(--motion-fast) disabled:opacity-50 disabled:cursor-not-allowed"
				:disabled="primaryDisabled || primaryLoading || held"
				:aria-disabled="held ? 'true' : undefined"
				@click.stop.prevent="emit('primary')"
			>
				<Icon
					v-if="primaryLoading"
					name="lucide:loader-2"
					class="w-3.5 h-3.5 animate-spin"
					aria-hidden="true"
				/>
				<Icon v-else-if="primaryIcon" :name="primaryIcon" class="w-3.5 h-3.5" aria-hidden="true" />
				{{ primaryLabel }}
			</button>
			<slot />
			<button
				v-if="skipLabel"
				type="button"
				:data-testid="skipTestId"
				class="text-xs px-2 py-1.5 rounded transition-colors duration-(--motion-fast) disabled:opacity-50"
				:class="
					skipDestructive
						? 'text-error hover:bg-error-subtle'
						: 'text-text-tertiary hover:text-text-primary hover:bg-bg-elevated'
				"
				:disabled="skipDisabled"
				@click.stop.prevent="emit('skip')"
			>
				{{ skipLabel }}
			</button>
			<span
				v-if="hints?.length"
				class="ml-auto hidden sm:flex items-center gap-x-3 text-[10px] text-text-tertiary"
				aria-hidden="true"
			>
				<span v-for="hint in hints" :key="hint.label" class="inline-flex items-center gap-1">
					<kbd
						v-for="k in hint.keys"
						:key="k"
						class="px-1 py-px rounded border border-border-subtle bg-bg-surface font-mono text-[9px] text-text-secondary"
						>{{ k }}</kbd
					>
					<span>{{ hint.label }}</span>
				</span>
			</span>
		</div>

		<!-- Soft-hold reason: a teammate is replying; releases on its own. -->
		<p
			v-if="held && heldReason"
			class="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary"
			data-testid="task-held-reason"
			role="status"
		>
			<Icon name="lucide:pencil-line" class="w-3 h-3 text-warning shrink-0" aria-hidden="true" />
			<span>{{ heldReason }}</span>
		</p>
	</div>
</template>
