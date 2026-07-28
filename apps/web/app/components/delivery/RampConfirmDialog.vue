<script setup lang="ts">
/**
 * A CONSEQUENCE-NAMING CONFIRMATION.
 *
 * Two actions in this product can lose reputation that took weeks to build:
 * forcing a share past the evidence, and disconnecting the relay a cell is still
 * leaning on. Neither may be reachable from a single click, so both come through
 * here — and "cannot fire from a single click" is enforced by the shape of the
 * component rather than by a habit: the confirm button is disabled until the
 * exact phrase has been typed, and the phrase is the same constant the SERVER
 * checks (`@owlat/shared/deliverabilityIndependence`), so a client that skipped
 * this dialog meets the same rule anyway.
 *
 * `aria-modal` IS A PROMISE ABOUT THE KEYBOARD, so this component keeps it:
 * focus moves into the phrase input on open, Tab cycles inside the dialog rather
 * than wandering into the page behind it, Escape cancels, and focus returns to
 * whatever opened it. A destructive confirmation a keyboard user can tab out of
 * without noticing is not a confirmation.
 *
 * IT NAMES THE CONSEQUENCE, NOT THE RISK IN GENERAL. The `consequence` slot is
 * required to say what specifically happens to this deployment — which cells,
 * how much traffic, and what date it would be safe instead. "This may affect
 * deliverability" is the sentence this component exists to prevent.
 */
import { isConfirmationPhraseMatch } from '@owlat/shared/deliverabilityIndependence';

const props = defineProps<{
	open: boolean;
	title: string;
	/** The exact words the operator must type. Shared with the server check. */
	phrase: string;
	confirmLabel: string;
	busy?: boolean;
}>();

const emit = defineEmits<{ confirm: [phrase: string]; cancel: [] }>();

const typed = ref('');
const headingId = useId();
const descriptionId = useId();
const inputId = useId();
const dialogEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
/** Whatever had focus when the dialog opened, so it can be given back. */
let opener: HTMLElement | null = null;

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableNodes(): HTMLElement[] {
	const root = dialogEl.value;
	if (root === null) return [];
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * Tab stays inside. Written as a wrap rather than as a sentinel pair of hidden
 * tabbable nodes, because the confirm button's `disabled` state changes while
 * the dialog is open and a static sentinel would fall out of step with it.
 */
function trapTab(event: KeyboardEvent): void {
	const nodes = focusableNodes();
	const first = nodes[0];
	const last = nodes[nodes.length - 1];
	if (first === undefined || last === undefined) return;
	const active = document.activeElement;
	if (event.shiftKey && active === first) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && active === last) {
		event.preventDefault();
		first.focus();
	}
}

const canConfirm = computed(
	() => props.busy !== true && isConfirmationPhraseMatch(typed.value, props.phrase)
);

watch(
	() => props.open,
	async (open) => {
		// A stale phrase left in the box would make the NEXT open one click away
		// from confirming, which is exactly the property this dialog is for.
		if (!open) {
			typed.value = '';
			// Focus goes back where it came from, so a keyboard user is not dropped
			// at the top of the document after cancelling.
			const returnTo = opener;
			opener = null;
			returnTo?.focus();
			return;
		}
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		await nextTick();
		inputEl.value?.focus();
	}
);

function confirm(): void {
	if (!canConfirm.value) return;
	emit('confirm', typed.value);
}
</script>

<template>
	<div
		v-if="open"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
		data-testid="ramp-confirm-dialog"
	>
		<div
			ref="dialogEl"
			role="dialog"
			aria-modal="true"
			:aria-labelledby="headingId"
			:aria-describedby="descriptionId"
			class="w-full max-w-lg space-y-4 rounded-xl bg-bg-surface p-6 shadow-lg"
			@keydown.esc.prevent="emit('cancel')"
			@keydown.tab="trapTab"
		>
			<h2 :id="headingId" class="text-lg font-semibold text-text-primary">{{ title }}</h2>

			<div :id="descriptionId" class="space-y-2 text-sm text-text-secondary">
				<slot name="consequence" />
			</div>

			<div class="space-y-1">
				<label :for="inputId" class="block text-sm text-text-primary">
					Type <span class="font-mono font-semibold">{{ phrase }}</span> to confirm
				</label>
				<input
					:id="inputId"
					ref="inputEl"
					v-model="typed"
					type="text"
					autocomplete="off"
					spellcheck="false"
					class="w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary"
					data-testid="ramp-confirm-input"
					@keydown.enter.prevent="confirm"
				/>
			</div>

			<div class="flex justify-end gap-2">
				<button
					type="button"
					class="rounded-md px-3 py-2 text-sm text-text-secondary"
					data-testid="ramp-confirm-cancel"
					@click="emit('cancel')"
				>
					Cancel
				</button>
				<button
					type="button"
					:disabled="!canConfirm"
					class="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
					data-testid="ramp-confirm-submit"
					@click="confirm"
				>
					{{ confirmLabel }}
				</button>
			</div>
		</div>
	</div>
</template>
