import type { Ref } from 'vue';
import { usePostboxOptimisticHide } from '~/composables/postbox/usePostboxOptimisticHide';
import { usePostboxTriageUndo, type UndoGroup } from '~/composables/postbox/usePostboxTriageUndo';
import { runBounded } from '~/utils/runBounded';

/**
 * Optimistic triage + undo for the Team Inbox list — the same craft the Postbox
 * message list has (assemble the two Postbox house composables rather than
 * duplicate them):
 *
 *  - `usePostboxOptimisticHide` removes a row the instant its action fires, so a
 *    resolve/snooze/reassign feels instant instead of waiting on the live
 *    subscription. A failed mutation restores the row. (The ConvexClient does
 *    support native optimistic updates, via `useBackendOperation`'s
 *    `optimisticUpdate`; this hide set covers the view-local "leaves the
 *    filter" case, which the forward runner may pair with one.)
 *  - `usePostboxTriageUndo` surfaces the "Resolved — Undo" toast (also
 *    reachable with Cmd/Ctrl+Z outside text fields, which that composable binds
 *    app-wide) whose inverse re-runs the reverse mutation. Its registry is a
 *    bounded stack, so a burst of resolves walks back one keypress at a time;
 *    a bulk verb (`batch`) is one entry however many rows it touched.
 *
 * The caller supplies, per action, the row id, the toast label, whether the row
 * leaves the current filtered view (only then is it optimistically hidden — a
 * hidden row that the server keeps would otherwise stay stuck hidden), and the
 * forward + inverse mutations (each an already-wrapped `useBackendOperation`
 * runner that returns `undefined` on failure and never throws).
 */
export function useInboxTriage<T extends { _id: string }>(rows: Ref<T[]>) {
	const { visible, hide, unhide } = usePostboxOptimisticHide(rows);
	const undo = usePostboxTriageUndo();

	/** One row's action, as {@link run} and a {@link batch}'s `run` take it. */
	interface RowAction {
		id: T['_id'];
		/** True when the action removes the row from the active filter. */
		leavesView: boolean;
		/** Forward mutation — a `run` whose envelope says whether it landed. */
		mutate: () => Promise<BackendOperationResult<unknown>>;
		/** Reverse mutation, run when the user undoes. */
		inverse: () => Promise<unknown>;
	}

	/**
	 * Hide the row (when it leaves the view) and run its forward mutation.
	 * Returns its undo (reveal, then reverse) when the write landed, or null
	 * after rolling the row back.
	 */
	async function forward(args: RowAction): Promise<(() => Promise<void>) | null> {
		if (args.leavesView) hide(args.id);
		const result = await args.mutate();
		if (!result.ok) {
			if (args.leavesView) unhide(args.id);
			return null;
		}
		return async () => {
			// Reveal the row again immediately; the reverse mutation re-adds it
			// server-side, and the live subscription reconciles either way.
			if (args.leavesView) unhide(args.id);
			await args.inverse();
		};
	}

	/**
	 * Run one triage action optimistically. Returns `true` when the forward
	 * mutation succeeded (and an undo entry was registered), `false` when it
	 * failed (the row is rolled back; `useBackendOperation` already toasted the
	 * error).
	 */
	async function run(
		args: RowAction & {
			/** Toast text, e.g. "Resolved" / "Snoozed" / "Assigned to you". */
			label: string;
			/**
			 * How consecutive actions of this kind share one toast ("Resolved 3
			 * conversations · Undo all"); each action still undoes on its own.
			 */
			group?: UndoGroup;
		}
	): Promise<boolean> {
		const inverse = await forward(args);
		if (!inverse) return false;
		undo.register({
			label: args.label,
			...(args.group ? { group: args.group } : {}),
			inverse,
		});
		return true;
	}

	/**
	 * One verb over many rows, undone as ONE action. Each row hides and rolls
	 * back on its own, but the rows whose write landed share a single undo
	 * entry that `commit` registers once every write has settled. The undo
	 * stack keeps ten entries, so one entry per row would let a bulk verb's
	 * later rows evict its earlier ones, leaving part of the run irreversible.
	 */
	function batch() {
		const landed: Array<() => Promise<void>> = [];
		return {
			/** Like {@link run}, without registering: the row's undo waits for `commit`. */
			async run(args: RowAction): Promise<boolean> {
				const inverse = await forward(args);
				if (!inverse) return false;
				landed.push(inverse);
				return true;
			},
			/**
			 * Register the landed rows' undo. `label` is the text for one row;
			 * several use `group.label(count)`. Their reverse mutations run
			 * `concurrency` at a time. Registers nothing when no row landed.
			 */
			commit(args: { label: string; group?: UndoGroup; concurrency?: number }) {
				const inverses = landed.splice(0);
				if (inverses.length === 0) return;
				const count = inverses.length;
				undo.register({
					label: count > 1 && args.group ? args.group.label(count) : args.label,
					...(args.group ? { group: { ...args.group, count } } : {}),
					inverse: () => runBounded(inverses, args.concurrency ?? 1, (inverse) => inverse()),
				});
			},
		};
	}

	return { visible, run, batch };
}
