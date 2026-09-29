import { fn } from '../../convex.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession } from '../helpers/session.js';
import { runCopyOrMove } from '../helpers/copyMove.js';
import { seqForUid } from '../helpers/seqMap.js';

interface MoveArgs {
	readonly set: string;
	readonly target: string;
	readonly byUid: boolean;
}

/**
 * MOVE (RFC 6851) — atomically COPY + EXPUNGE. Each moved source message
 * is reported as `* n EXPUNGE` with its sequence number from the seq map
 * the set was resolved against, highest first, so every number is still
 * valid when the client reads it (RFC 3501 §7.4.1).
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
				mutation: fn.moveMessages,
				send,
				emit: (result, seqMap) => {
					if (result.pairs.length > 0) {
						const sources = result.pairs.map((p) => p.sourceUid).join(',');
						const targets = result.pairs.map((p) => p.targetUid).join(',');
						send(`* OK [COPYUID ${result.uidValidity} ${sources} ${targets}] Move`);
						const expunged = result.pairs
							.map((p) => seqForUid(seqMap, p.sourceUid))
							.filter((seq): seq is number => seq !== undefined)
							.sort((a, b) => b - a);
						for (const seq of expunged) {
							send(`* ${seq} EXPUNGE`);
						}
					}
					send(`${tag} OK ${label} completed`);
				},
			})
		);
	},
};
