import type { Ref } from 'vue';
import { usePostboxOptimisticHide } from '~/composables/postbox/usePostboxOptimisticHide';
import { usePostboxTriageUndo } from '~/composables/postbox/usePostboxTriageUndo';

/**
 * Optimistic triage + undo for the Team Inbox list — the same craft the Postbox
 * message list has (assemble the two Postbox house composables rather than
 * duplicate them):
 *
 *  - `usePostboxOptimisticHide` removes a row the instant its action fires, so a
 *    resolve/snooze/reassign feels instant instead of waiting on the live
 *    subscription. A failed mutation restores the row; the ConvexClient has no
 *    native optimistic updates.
 *  - `usePostboxTriageUndo` surfaces the one-slot "Resolved — Undo" toast (also
 *    reachable with Cmd/Ctrl+Z outside text fields) whose inverse re-runs the
 *    reverse mutation.
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

	/**
	 * Run one triage action optimistically. Returns `true` when the forward
	 * mutation succeeded (and an undo entry was registered), `false` when it
	 * failed (the row is rolled back; `useBackendOperation` already toasted the
	 * error).
	 */
	async function run(args: {
		id: T['_id'];
		/** Toast text, e.g. "Resolved" / "Snoozed" / "Assigned to you". */
		label: string;
		/** True when the action removes the row from the active filter. */
		leavesView: boolean;
		/** Forward mutation — resolves to `undefined` on failure. */
		mutate: () => Promise<unknown>;
		/** Reverse mutation, run when the user undoes. */
		inverse: () => Promise<unknown>;
	}): Promise<boolean> {
		if (args.leavesView) hide(args.id);
		const result = await args.mutate();
		if (result === undefined) {
			if (args.leavesView) unhide(args.id);
			return false;
		}
		undo.register({
			label: args.label,
			inverse: async () => {
				// Reveal the row again immediately; the reverse mutation re-adds it
				// server-side, and the live subscription reconciles either way.
				if (args.leavesView) unhide(args.id);
				await args.inverse();
			},
		});
		return true;
	}

	return { visible, run, onWindowKeydown: undo.onWindowKeydown };
}
