<script setup lang="ts">
/**
 * The graceful placeholder shown when a task-flow card can't be rendered — an
 * unknown kind (never registered, e.g. a plugin was removed) or a disabled kind
 * (its feature flag is off). It never crashes and never lets the queue swallow
 * the item silently: the card is always skippable (and openable when a
 * destination is known), so the user can move past it and reach it elsewhere.
 *
 * Presentational only — no brand spine (this isn't the agent asking a question),
 * a muted tone, existing design tokens, and the shared card keyboard's `s`
 * (skip) affordance surfaced as a hint.
 *
 * Explicitly imported by TaskCardRenderer; never relied on via auto-import.
 */
import { computed } from 'vue';
import TaskCardShell from '~/components/agent-tasks/TaskCardShell.vue';

const props = withDefaults(
	defineProps<{
		/** Why the card is a placeholder — drives the copy. */
		reason: 'unknown' | 'disabled';
		/** The kind that could not be rendered (shown as a muted mono tag). */
		kind: string;
		/** Human label for a disabled kind, when the registry knew one. */
		label?: string;
		/** Show an "Open" affordance (a destination exists outside the flow). */
		canOpen?: boolean;
	}>(),
	{ label: '', canOpen: false }
);

const emit = defineEmits<{ (e: 'skip'): void; (e: 'open'): void }>();

/**
 * One copy table per reason (icon + title + body), so the three fragments of a
 * placeholder's message are defined together and can't drift independently.
 */
/** Hard length clamp for the untrusted kind string shown as a mono tag. */
const MAX_KIND_TAG_LENGTH = 80;
const kindTag = computed(() =>
	props.kind.length > MAX_KIND_TAG_LENGTH
		? `${props.kind.slice(0, MAX_KIND_TAG_LENGTH)}…`
		: props.kind
);

const copy = computed(() =>
	props.reason === 'disabled'
		? {
				icon: 'lucide:eye-off',
				title: `${props.label || 'This task type'} is turned off`,
				body: 'Re-enable its feature to review it in the flow, or skip it for now.',
			}
		: {
				icon: 'lucide:help-circle',
				title: "This task can't be shown here",
				body: 'It may belong to a plugin that is no longer installed. Skip it to move on.',
			}
);
</script>

<template>
	<TaskCardShell :spine="false" role="group" aria-label="Unavailable task">
		<div class="flex items-start gap-3">
			<UiIconBox
				:icon="copy.icon"
				size="md"
				variant="surface"
				rounded="lg"
				class="flex-shrink-0"
			/>
			<div class="min-w-0">
				<p class="text-sm font-medium text-text-primary">
					{{ copy.title }}
				</p>
				<p class="mt-0.5 text-xs text-text-tertiary">
					{{ copy.body }}
					<span
						v-if="kind"
						class="ml-1 inline-block max-w-full truncate font-mono text-[10px] px-1 py-px rounded bg-bg-elevated text-text-tertiary align-middle"
						>{{ kindTag }}</span
					>
				</p>
			</div>
		</div>

		<div class="mt-4 flex items-center gap-2">
			<button
				type="button"
				data-testid="task-fallback-skip"
				class="btn btn-secondary text-sm"
				@click="emit('skip')"
			>
				Skip
				<kbd
					class="ml-1.5 text-[10px] px-1 py-px rounded border border-border-subtle text-text-tertiary"
					>s</kbd
				>
			</button>
			<button
				v-if="canOpen"
				type="button"
				data-testid="task-fallback-open"
				class="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast)"
				@click="emit('open')"
			>
				<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
				Open
			</button>
		</div>
	</TaskCardShell>
</template>
