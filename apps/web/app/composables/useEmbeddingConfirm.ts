/**
 * One confirmation at a time for the embedding section's controls that cost
 * money or cannot be undone. `ask` either runs the action at once (free and
 * harmless work) or holds it until the admin confirms; the component renders
 * one `UiConfirmationDialog` from `pending`.
 *
 * A held confirmation is bound to its TARGET: the space, job or identity its
 * dialog names, captured as `targetKey` when it is asked. The endpoints act on
 * whatever is staged, active or configured when they run, so a dialog naming
 * model A must never go on to act on model B after another admin replaced the
 * staged space or changed settings. The binding is checked twice: the dialog
 * closes as soon as the live target (`currentKey`) moves, and `confirm`
 * re-reads the target and the blocker before it runs anything. (Once the
 * endpoints take an expected target, the server checks it too.)
 */
import { ref, watch } from 'vue';

export interface EmbeddingConfirmation {
	title: string;
	body: string;
	confirmText: string;
	isDanger?: boolean;
	/** The target the dialog names, as a stable key. */
	targetKey: string;
	/** The live target's key, read again before running; null: it is gone. */
	currentKey: () => string | null;
	/** Why it may not run now (paid work without admission, a job opened), or null. */
	blocker?: () => string | null;
	run: () => Promise<boolean>;
}

export function useEmbeddingConfirm() {
	const pending = ref<EmbeddingConfirmation | null>(null);

	const isStillValid = (held: EmbeddingConfirmation) =>
		held.currentKey() === held.targetKey && (held.blocker?.() ?? null) === null;

	// The subscription moved the target, or a blocker appeared: the dialog no
	// longer describes what Confirm would do, so it goes.
	watch(
		() => {
			const held = pending.value;
			return held ? isStillValid(held) : true;
		},
		(isValid) => {
			if (!isValid) pending.value = null;
		}
	);

	/** Run `confirmation.run` now, or after a confirmation when `isNeeded`. */
	async function ask(isNeeded: boolean, confirmation: EmbeddingConfirmation): Promise<void> {
		if (!isStillValid(confirmation)) return;
		if (!isNeeded) {
			await confirmation.run();
			return;
		}
		pending.value = confirmation;
	}

	/** The admin confirmed: re-check the target, run it, and close once it landed. */
	async function confirm(): Promise<void> {
		const held = pending.value;
		if (!held) return;
		if (!isStillValid(held)) {
			pending.value = null;
			return;
		}
		if (await held.run()) pending.value = null;
	}

	function dismiss(open: boolean) {
		if (!open) pending.value = null;
	}

	return { pending, ask, confirm, dismiss };
}
