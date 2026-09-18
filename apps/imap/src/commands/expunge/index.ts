import { fn } from '../../convex.js';
import { logger } from '../../logger.js';
import { parseUidSet } from '../../parser.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { requireAuth, requireSelect, requireWritableSelect } from '../helpers/auth.js';

export interface ExpungeArgs {
	/** Present iff this is UID EXPUNGE. */
	readonly uidSpec?: string;
}

interface ExpungeResult {
	readonly sequenceNumbers: number[];
	readonly modseq: number;
	readonly done?: boolean;
	readonly beforeUid?: number;
	readonly nextSequenceNumber?: number;
}

/**
 * EXPUNGE removes `\Deleted` messages. UID EXPUNGE narrows the operation
 * to a UID set; bare EXPUNGE clears the whole folder.
 *
 * The pre-deepening handler mutated `this.selected.totalCount` and
 * `this.selected.highestModseq` directly; under immutable state the
 * module returns a new SelectedState the pump applies.
 */
export const expungeModule: ImapCommandModule<ExpungeArgs> = {
	verbs: ['EXPUNGE'],
	parseArgs(rawArgs) {
		// Bare EXPUNGE has no args; UID dispatcher passes the rest through.
		return { ok: true, args: { uidSpec: rawArgs[0] } };
	},
	start({ deps, state, args, tag, send }) {
		const fail =
			requireAuth(state, tag) ?? requireSelect(state, tag) ?? requireWritableSelect(state, tag);
		if (fail) {
			send(fail);
			return syncSession();
		}

		const label = args.uidSpec ? 'UID EXPUNGE' : 'EXPUNGE';

		let uidSet: number[] | undefined;
		if (args.uidSpec) {
			const ranges = parseUidSet(args.uidSpec, state.selected!.uidNext - 1);
			uidSet = [];
			for (const [low, high] of ranges) {
				for (let u = low; u <= high; u++) uidSet.push(u);
			}
		}

		return asyncSession(async () => {
			try {
				let selected = state.selected!;
				let beforeUid: number | undefined;
				let nextSequenceNumber: number | undefined;
				do {
					const result = (await deps.convex.mutation(
						fn.expungeFolder as never,
						{
							folderId: state.selected!.folderId,
							uidSet,
							beforeUid,
							nextSequenceNumber,
						} as never
					)) as ExpungeResult;
					// Each page has already committed. Publish it before requesting the
					// next page so a later failure cannot hide permanent deletions.
					for (const seq of [...result.sequenceNumbers].sort((a, b) => b - a)) {
						send(`* ${seq} EXPUNGE`);
					}
					selected = {
						...selected,
						totalCount: Math.max(0, selected.totalCount - result.sequenceNumbers.length),
						highestModseq: result.modseq,
					};
					deps.commit({ ...state, selected });
					if (result.done !== false) break;
					beforeUid = result.beforeUid;
					nextSequenceNumber = result.nextSequenceNumber;
				} while (beforeUid !== undefined && nextSequenceNumber !== undefined);

				send(`${tag} OK ${label} completed`);
			} catch (err) {
				logger.error({ err }, 'EXPUNGE failed');
				send(`${tag} BAD EXPUNGE failed`);
			}
		});
	},
};
