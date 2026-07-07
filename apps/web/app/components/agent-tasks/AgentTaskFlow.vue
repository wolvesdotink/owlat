<script setup lang="ts">
/**
 * The focused card-stack shell — ONE agent task on screen at a time, with
 * progress + time estimate above, a muted "next" peek below, and auto-advance
 * motion between cards. Purely presentational: the owning page drives it from a
 * useTaskFlow instance and supplies the current card in the default slot.
 *
 * Fluid Functionalism: a single centered doing-column (never a second focal
 * point), weight — not colour — for emphasis, the brand accent only on the
 * primary action inside the card, motion as information (a completed card
 * exits upward, the next enters on the bouncy spring — the `pbx-cardstack`
 * transition, opacity-only under reduced motion).
 *
 * Keyboard: Esc exits the flow (the page preserves position). Cmd/Ctrl+Z undo
 * is owned by the page's useTaskFlow (window handler) so it works from anywhere.
 *
 * Explicitly imported by consumers (never via the path-prefixed auto-import).
 */
withDefaults(
	defineProps<{
		/** 1-based position of the current card. */
		position: number;
		/** Total cards in the flow (grows as new items arrive). */
		total: number;
		/** Count of items that arrived after entry — the quiet "+n new" hint. */
		newCount?: number;
		/** Rough remaining-time label, e.g. "about 4 min" (omit to hide). */
		estimateLabel?: string;
		/** Key for the current card — drives the advance transition. */
		currentKey?: string | null;
		/** Muted one-liner naming the next task (the peek). */
		peekLabel?: string;
		/** True at the end state (all cards cleared). */
		complete?: boolean;
		/** Whether an undo is available (shows the quiet Cmd+Z affordance). */
		canUndo?: boolean;
	}>(),
	{
		newCount: 0,
		estimateLabel: '',
		currentKey: null,
		peekLabel: '',
		complete: false,
		canUndo: false,
	}
);

const emit = defineEmits<{ (e: 'exit'): void; (e: 'undo'): void }>();

// Esc exits from anywhere in the flow (position is preserved by the page).
function onKeydown(event: KeyboardEvent) {
	if (event.key === 'Escape') {
		event.preventDefault();
		emit('exit');
	}
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

// Progress dots stay legible only for short flows; longer ones use the bar.
const MAX_DOTS = 9;
</script>

<template>
	<div class="max-w-2xl mx-auto px-4 sm:px-6 py-6">
		<!-- Progress + estimate + exit — the only chrome around the doing-column. -->
		<header class="mb-5">
			<div class="flex items-center justify-between gap-4">
				<div class="flex items-baseline gap-2 min-w-0">
					<span class="text-sm font-medium text-text-primary tabular-nums">
						{{ complete ? total : position }} of {{ total }}
					</span>
					<span
						v-if="newCount > 0 && !complete"
						class="text-xs text-brand tabular-nums"
						:title="`${newCount} arrived since you started`"
					>
						+{{ newCount }} new
					</span>
					<span v-if="estimateLabel && !complete" class="text-xs text-text-tertiary truncate">
						· {{ estimateLabel }} left
					</span>
				</div>
				<div class="flex items-center gap-3 flex-shrink-0">
					<button
						v-if="canUndo"
						type="button"
						class="inline-flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast)"
						title="Undo last (⌘Z)"
						@click="emit('undo')"
					>
						<Icon name="lucide:undo-2" class="w-3.5 h-3.5" />
						Undo
					</button>
					<button
						type="button"
						class="inline-flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast)"
						title="Exit (Esc)"
						@click="emit('exit')"
					>
						<Icon name="lucide:x" class="w-3.5 h-3.5" />
						Exit
					</button>
				</div>
			</div>

			<!-- Progress dots for short flows, a thin bar for long ones. -->
			<div v-if="total > 0" class="mt-3">
				<div
					v-if="total <= MAX_DOTS"
					class="flex items-center gap-1.5"
					role="progressbar"
					:aria-valuenow="complete ? total : position - 1"
					aria-valuemin="0"
					:aria-valuemax="total"
				>
					<span
						v-for="i in total"
						:key="i"
						class="h-1.5 rounded-full transition-all duration-(--motion-moderate)"
						:class="
							(complete ? true : i < position)
								? 'w-5 bg-brand'
								: i === position && !complete
									? 'w-5 bg-brand/40'
									: 'w-1.5 bg-border-strong'
						"
					/>
				</div>
				<div
					v-else
					class="h-1.5 rounded-full bg-border-subtle overflow-hidden"
					role="progressbar"
					:aria-valuenow="complete ? total : position - 1"
					aria-valuemin="0"
					:aria-valuemax="total"
				>
					<div
						class="h-full bg-brand rounded-full transition-all duration-(--motion-slow)"
						:style="{
							width: `${Math.round(((complete ? total : position - 1) / total) * 100)}%`,
						}"
					/>
				</div>
			</div>
		</header>

		<!-- The doing-column: exactly one card, or the end state. -->
		<div class="relative">
			<Transition name="pbx-cardstack" mode="out-in">
				<!-- End state -->
				<div v-if="complete" key="__done__">
					<slot name="done" />
				</div>
				<!-- Current card (keyed so the transition fires on advance) -->
				<div v-else :key="currentKey ?? '__current__'">
					<slot />
				</div>
			</Transition>
		</div>

		<!-- Muted "next:" peek — depth on demand, one task still the focus. -->
		<footer v-if="!complete && (peekLabel || $slots.peek)" class="mt-4 px-1">
			<p class="text-xs text-text-tertiary truncate">
				<span class="text-text-tertiary/80">Next:</span>
				<slot name="peek">{{ peekLabel }}</slot>
			</p>
		</footer>
	</div>
</template>
