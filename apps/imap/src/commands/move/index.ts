import { fn } from '../../convex.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession } from '../helpers/session.js';
import { runCopyOrMove } from '../helpers/copyMove.js';
import { seqForUid } from '../helpers/seqMap.js';
import { inBatches } from '../helpers/uidSet.js';

interface MoveArgs {
	readonly set: string;
	readonly target: string;
	readonly byUid: boolean;
}

/**
 * MOVE (RFC 6851) — COPY + EXPUNGE as one step. Each moved source message
 * is reported as `* n EXPUNGE` with its sequence number from the seq map
 * the set was resolved against, highest first, so every number is still
 * valid when the client reads it (RFC 3501 §7.4.1), and the selected
 * state's message count drops by the same amount.
 *
 * A large set moves in batches, lowest UIDs first, and each batch is reported
 * (`* OK [COPYUID …] Move` and its EXPUNGE lines) as soon as it has committed.
 * Every message in a later batch sits above every message already expunged, so
 * its sequence number is lowered by the count reported so far. If a batch
 * fails, the batches before it stay moved and reported and the command answers
 * NO: RFC 6851 §3.3 allows a partial MOVE as long as each message is either
 * moved or left in place.
 */
export const moveModule: ImapCommandModule<MoveArgs> = {
	verbs: ['MOVE'],
	capabilities: ['MOVE'],
	requires: 'writable',
	parseArgs(rawArgs) {
		const [set, target] = rawArgs;
		if (!set || !target) {
			return { ok: false, error: 'MOVE requires <set> <target>' };
		}
		return { ok: true, args: { set, target, byUid: false } };
	},
	start({ deps, state, args, tag, send }) {
		const label = args.byUid ? 'UID MOVE' : 'MOVE';

		return asyncSession(() =>
			runCopyOrMove({
				deps,
				state,
				set: args.set,
				byUid: args.byUid,
				target: args.target,
				tag,
				label,
				verb: 'MOVE',
				send,
				apply: async ({ sourceFolderId, targetFolderId, messageIds, seqMap }) => {
					let selected = state.selected!;
					let expungedSoFar = 0;
					for (const batch of inBatches(messageIds)) {
						const result = await deps.convex.mutation(fn.moveMessages, {
							sourceFolderId,
							targetFolderId,
							messageIds: batch,
						});
						if (result.pairs.length === 0) continue;
						const sources = result.pairs.map((p) => p.sourceUid).join(',');
						const targets = result.pairs.map((p) => p.targetUid).join(',');
						send(`* OK [COPYUID ${result.uidValidity} ${sources} ${targets}] Move`);
						const expunged = result.pairs
							.map((p) => seqForUid(seqMap, p.sourceUid))
							.filter((seq): seq is number => seq !== undefined)
							.sort((a, b) => b - a);
						for (const seq of expunged) {
							send(`* ${seq - expungedSoFar} EXPUNGE`);
						}
						expungedSoFar += expunged.length;
						// Keep the selected message count in step with the EXPUNGE
						// lines just sent, as EXPUNGE does.
						selected = {
							...selected,
							totalCount: Math.max(0, selected.totalCount - expunged.length),
						};
						deps.commit({ ...state, selected });
					}
					send(`${tag} OK ${label} completed`);
				},
			})
		);
	},
};
