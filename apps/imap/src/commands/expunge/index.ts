import { fn } from '../../convex.js';
import { logger } from '../../logger.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { serverFailure } from '../helpers/replies.js';
import { resolveSelectedSet } from '../helpers/seqMap.js';
import { expungeFromView, syncSequenceView } from '../helpers/sequenceView.js';
import { loadCurrentUids } from '../helpers/membership.js';

interface ExpungeArgs {
	/** The UID set of a UID EXPUNGE; absent for a whole-folder sweep. */
	readonly uidSpec?: string;
	/** Set by the UID dispatcher for UID EXPUNGE. */
	readonly byUid: boolean;
}

/**
 * EXPUNGE removes `\Deleted` messages. UID EXPUNGE narrows the operation
 * to a UID set; bare EXPUNGE clears the whole folder. The UID set is resolved
 * against the folder first, so the mutation receives only UIDs that exist in
 * it, never an expansion of the raw ranges.
 *
 * Both first bring the client's sequence view up to date (announcing other
 * sessions' changes), then number each expunged message against that view, the
 * numbering the client holds, and take it out of the view as it is announced.
 *
 * The pre-deepening handler mutated `this.selected.totalCount` and
 * `this.selected.highestModseq` directly; under immutable state the
 * module returns a new SelectedState the pump applies.
 */
export const expungeModule: ImapCommandModule<ExpungeArgs> = {
	verbs: ['EXPUNGE'],
	requires: 'writable',
	parseArgs(rawArgs) {
		// Bare EXPUNGE has no args; UID dispatcher passes the rest through.
		// Whether an argument is allowed depends on `byUid`, which the UID
		// dispatcher sets only after parsing, so start() rejects a plain
		// EXPUNGE that carries one.
		return { ok: true, args: { uidSpec: rawArgs[0], byUid: false } };
	},
	start({ deps, state, args, tag, send }) {
		const label = args.byUid ? 'UID EXPUNGE' : 'EXPUNGE';

		const uidSpec = args.uidSpec;
		// RFC 3501 EXPUNGE takes no arguments; a set here must not quietly turn
		// it into UID EXPUNGE.
		if (!args.byUid && uidSpec !== undefined) {
			send(`${tag} BAD EXPUNGE takes no arguments`);
			return syncSession();
		}

		return asyncSession(async () => {
			try {
				let uidSet: number[] | undefined;
				if (uidSpec) {
					const { resolved } = await resolveSelectedSet(deps, state, uidSpec, true, send);
					if (resolved.length === 0) {
						send(`${tag} OK ${label} completed`);
						return;
					}
					uidSet = resolved.map((r) => r.uid);
				} else if (state.selected!.view) {
					await syncSequenceView(deps, state, send);
				}
				const view = state.selected!.view;
				let viewNeedsReload = false;

				let selected = state.selected!;
				let beforeUid: number | undefined;
				let nextSequenceNumber: number | undefined;
				do {
					const result = await deps.convex.mutation(fn.expungeFolder, {
						folderId: state.selected!.folderId,
						uidSet,
						beforeUid,
						nextSequenceNumber,
					});
					// Each page has already committed. Publish it before requesting the
					// next page so a later failure cannot hide permanent deletions.
					let sequenceNumbers: number[];
					if (view && result.uids) {
						sequenceNumbers = expungeFromView(view, result.uids);
					} else {
						// A backend older than the view (no `uids`): its numbers are the
						// folder's own, and the view is re-read once the folder settles.
						sequenceNumbers = [...result.sequenceNumbers].sort((a, b) => b - a);
						viewNeedsReload = view !== undefined;
					}
					for (const seq of sequenceNumbers) send(`* ${seq} EXPUNGE`);
					selected = {
						...selected,
						totalCount: Math.max(0, selected.totalCount - sequenceNumbers.length),
						highestModseq: result.modseq,
					};
					deps.commit({ ...state, selected });
					if (result.done !== false) break;
					beforeUid = result.beforeUid;
					nextSequenceNumber = result.nextSequenceNumber;
				} while (beforeUid !== undefined && nextSequenceNumber !== undefined);
				if (view && viewNeedsReload) {
					view.uids = await loadCurrentUids(deps.convex, state.selected!.folderId);
				}

				send(`${tag} OK ${label} completed`);
			} catch (err) {
				logger.error({ err }, 'EXPUNGE failed');
				send(serverFailure(tag, label));
			}
		});
	},
};
