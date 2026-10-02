import { fn } from '../../convex.js';
import { logger } from '../../logger.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { serverFailure } from '../helpers/replies.js';
import { resolveSelectedSet } from '../helpers/seqMap.js';
import { expungeFromView, syncSequenceView } from '../helpers/sequenceView.js';
import { holdSequence } from '../helpers/sequenceGate.js';
import { inBatches } from '../helpers/uidSet.js';

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
 * The backend reports the expunged messages by UID; the sequence numbers it
 * also returns are counted from the folder's stored total and are only there
 * for an IMAP server older than the view, so they are not read here.
 *
 * A UID set goes to Convex in batches (Convex caps an array argument at 8,192
 * elements), highest UIDs first: the backend walks downwards and stops at each
 * batch's lowest UID, so the cursor it returns is where the next, lower batch
 * starts.
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
			const lease = holdSequence(deps, 'sync');
			try {
				await lease.ready;
				// A bare EXPUNGE is one walk of the folder.
				let uidBatches: Array<number[] | undefined> = [undefined];
				let current: readonly number[];
				if (uidSpec) {
					const { seqMap, resolved } = await resolveSelectedSet(
						deps,
						state,
						uidSpec,
						true,
						send,
						lease
					);
					if (resolved.length === 0) {
						send(`${tag} OK ${label} completed`);
						return;
					}
					current = seqMap.uids;
					// `resolved` is ascending, so the batches are taken from the end;
					// each batch itself stays ascending.
					uidBatches = inBatches(resolved.map((r) => r.uid)).reverse();
				} else {
					current = await syncSequenceView(deps, state, send, lease);
				}
				// Every EXPUNGE below renumbers the view: commands sent before this
				// one finish with the numbering they started with.
				await lease.exclusive();
				// A state built by hand (tests) has no view: number against the
				// folder as it was just read.
				const view = state.selected!.view ?? { uids: current };

				let selected = state.selected!;
				let beforeUid: number | undefined;
				for (const uidSet of uidBatches) {
					for (;;) {
						const result = await deps.convex.mutation(fn.expungeFolder, {
							folderId: state.selected!.folderId,
							uidSet,
							beforeUid,
						});
						// Each page has already committed. Publish it before requesting the
						// next page so a later failure cannot hide permanent deletions.
						const sequenceNumbers = expungeFromView(view, result.uids);
						for (const seq of sequenceNumbers) send(`* ${seq} EXPUNGE`);
						selected = {
							...selected,
							totalCount: Math.max(0, selected.totalCount - sequenceNumbers.length),
							highestModseq: result.modseq,
						};
						deps.commit({ ...state, selected });
						beforeUid = result.beforeUid;
						if (result.done !== false || beforeUid === undefined) break;
					}
				}

				send(`${tag} OK ${label} completed`);
			} catch (err) {
				logger.error({ err }, 'EXPUNGE failed');
				send(serverFailure(tag, label));
			} finally {
				lease.release();
			}
		});
	},
};
