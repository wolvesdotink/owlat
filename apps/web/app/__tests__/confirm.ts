/**
 * The real `useConfirm()` for component and composable suites, with the test
 * standing in for the dialog host: it reads the question on screen and answers
 * it, so a suite can assert what happens before, after a yes and after a no.
 */
import { vi } from 'vitest';
import { watch } from 'vue';
import {
	pendingConfirms,
	registerConfirmHost,
	respondToConfirm,
	useConfirm,
	type ConfirmRequest,
} from '~/composables/useConfirm';

export interface ConfirmDriver {
	/** Every open question, oldest (the one on screen) first. */
	readonly pending: readonly ConfirmRequest[];
	/** Every question asked since install, answered or not. */
	readonly asked: readonly ConfirmRequest[];
	/** Answer the question on screen; throws when none is open. */
	answer(confirmed: boolean): void;
	/**
	 * Answer every question the moment it is asked, for suites about what
	 * happens after the answer rather than about the asking.
	 */
	answerAll(confirmed: boolean): void;
	/** Take the host away again, answering anything still open with no. */
	dispose(): void;
}

export function installConfirm(): ConfirmDriver {
	vi.stubGlobal('useConfirm', useConfirm);
	const unregister = registerConfirmHost();
	const asked: ConfirmRequest[] = [];
	let automatic: boolean | null = null;
	const stop = watch(
		pendingConfirms,
		(pending) => {
			for (const request of pending) if (!asked.includes(request)) asked.push(request);
			const head = pending[0];
			if (head && automatic !== null) respondToConfirm(head.id, automatic);
		},
		{ flush: 'sync' }
	);
	return {
		get pending() {
			return pendingConfirms.value;
		},
		asked,
		answer(confirmed) {
			const head = pendingConfirms.value[0];
			if (!head) throw new Error('No confirmation is open.');
			respondToConfirm(head.id, confirmed);
		},
		answerAll(confirmed) {
			automatic = confirmed;
		},
		dispose() {
			stop();
			unregister();
		},
	};
}
