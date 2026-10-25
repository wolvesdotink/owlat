import { computed, type ComputedRef, type ShallowRef } from 'vue';
import type { DraftEvent, DraftLeaveKind, DraftSessionState } from '~/utils/draftSession';

/**
 * A draft's leave decisions as the router guard and the prompt use them
 * (`useUnsavedChanges`). Each request is a decision of the session
 * (`utils/draftSession.ts`); this keeps the promises its guard and its
 * prompt wait on, and answers them when the session settles them.
 */

export interface DraftLeaveDecisions {
	/** Resolves whether the page may go to `destination` now; false shows the prompt (or was superseded). */
	request: (destination: string, kind?: DraftLeaveKind) => Promise<boolean>;
	/** The leave prompt is open (a leave in this window). */
	choosing: ComputedRef<boolean>;
	/** The prompt for an editor opened in a new tab is open (the page stays). */
	tabChoosing: ComputedRef<boolean>;
	/** Its Save is running. */
	saving: ComputedRef<boolean>;
	/** Where the open decision would go. */
	destination: ComputedRef<string | null>;
	/** The prompt's Save; resolves where to go, or null to stay. */
	save: () => Promise<string | null>;
	/** The prompt's Discard; returns where to go, or null. */
	discard: () => string | null;
	/** Stay. */
	cancel: () => void;
	/** Leaving now would lose something (read synchronously, for `beforeunload`). */
	isAtRisk: () => boolean;
}

export function useDraftLeave(
	state: Readonly<ShallowRef<DraftSessionState>>,
	dispatch: (event: DraftEvent) => void,
	beforeRequest: () => void,
	isAtRisk: () => boolean
) {
	const verdicts = new Map<number, (leave: boolean) => void>();
	const settles = new Map<number, (destination: string | null) => void>();
	let requests = 0;

	/** The prompt of a decision of `kind` is open (its Save may be running). */
	const prompting = (kind: DraftLeaveKind) =>
		computed(() => {
			const current = state.value.leave;
			return current?.kind === kind && (current.phase === 'choosing' || current.phase === 'saving');
		});

	const leave: DraftLeaveDecisions = {
		request: (destination, kind = 'navigate') => {
			beforeRequest();
			requests += 1;
			const id = requests;
			const verdict = new Promise<boolean>((resolve) => verdicts.set(id, resolve));
			dispatch({ type: 'leave-requested', id, destination, kind });
			return verdict;
		},
		choosing: prompting('navigate'),
		tabChoosing: prompting('open-tab'),
		saving: computed(() => state.value.leave?.phase === 'saving'),
		destination: computed(() => state.value.leave?.destination ?? null),
		save: () => {
			const current = state.value.leave;
			if (!current || current.phase !== 'choosing') return Promise.resolve(null);
			const settled = new Promise<string | null>((resolve) => settles.set(current.id, resolve));
			dispatch({ type: 'leave-save', id: current.id });
			return settled;
		},
		discard: () => {
			const current = state.value.leave;
			if (!current || current.phase === 'saving') return null;
			let destination: string | null = null;
			settles.set(current.id, (to) => {
				destination = to;
			});
			dispatch({ type: 'leave-discard', id: current.id });
			return destination;
		},
		cancel: () => dispatch({ type: 'leave-cancel' }),
		isAtRisk,
	};

	const take = <T>(waiting: Map<number, T>, id: number) => {
		const resolve = waiting.get(id);
		waiting.delete(id);
		return resolve;
	};

	return {
		leave,
		/** The session's answer to a leave request's router guard. */
		answer: (id: number, go: boolean) => take(verdicts, id)?.(go),
		/** The session settled a prompt's choice: where to go, or null to stay. */
		settle: (id: number, destination: string | null) => take(settles, id)?.(destination),
	};
}
