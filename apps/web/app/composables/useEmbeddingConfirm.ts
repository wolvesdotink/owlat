/**
 * One confirmation at a time for the embedding section's controls that cost
 * money or cannot be undone. `ask` either runs the action at once (free and
 * harmless work) or holds it until the admin confirms; the component renders
 * one `UiConfirmationDialog` from `pending`.
 */
import { ref } from 'vue';

export interface EmbeddingConfirmation {
	title: string;
	body: string;
	confirmText: string;
	isDanger?: boolean;
	run: () => Promise<boolean>;
}

export function useEmbeddingConfirm() {
	const pending = ref<EmbeddingConfirmation | null>(null);

	/** Run `confirmation.run` now, or after a confirmation when `isNeeded`. */
	async function ask(isNeeded: boolean, confirmation: EmbeddingConfirmation): Promise<void> {
		if (!isNeeded) {
			await confirmation.run();
			return;
		}
		pending.value = confirmation;
	}

	/** The admin confirmed: run it, and close only once it landed. */
	async function confirm(): Promise<void> {
		const held = pending.value;
		if (!held) return;
		if (await held.run()) pending.value = null;
	}

	function dismiss(open: boolean) {
		if (!open) pending.value = null;
	}

	return { pending, ask, confirm, dismiss };
}
