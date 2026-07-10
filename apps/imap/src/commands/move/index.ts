import { fn } from '../../convex.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { requireAuth, requireSelect, requireWritableSelect } from '../helpers/auth.js';
import { runCopyOrMove } from '../helpers/copyMove.js';

export interface MoveArgs {
	readonly set: string;
	readonly target: string;
	readonly byUid: boolean;
}

/**
 * MOVE (RFC 6851) — atomically COPY + EXPUNGE. Today we can't easily
 * compute the source sequence numbers without re-querying, so the
 * untagged EXPUNGE responses all address seq 1 — most clients tolerate
 * this since they re-fetch the folder anyway.
 */
export const moveModule: ImapCommandModule<MoveArgs> = {
	verbs: ['MOVE'],
	capabilities: ['MOVE'],
	parseArgs(rawArgs) {
		const [set, target] = rawArgs;
		if (!set || !target) {
			return { ok: false, error: 'MOVE requires <set> <target>' };
		}
		return { ok: true, args: { set, target, byUid: false } };
	},
	start({ deps, state, args, tag, send }) {
		const fail =
			requireAuth(state, tag) ??
			requireSelect(state, tag) ??
			requireWritableSelect(state, tag);
		if (fail) {
			send(fail);
			return syncSession();
		}

		const label = args.byUid ? 'UID MOVE' : 'MOVE';

		return asyncSession(() =>
			runCopyOrMove({
				deps,
				state,
				set: args.set,
				target: args.target,
				tag,
				label,
				verb: 'MOVE',
				mutation: fn.moveMessages,
				send,
				emit: (result) => {
					if (result.pairs.length > 0) {
						const sources = result.pairs.map((p) => p.sourceUid).join(',');
						const targets = result.pairs.map((p) => p.targetUid).join(',');
						send(`* OK [COPYUID ${result.uidValidity} ${sources} ${targets}] Move`);
						for (const _ of result.pairs) {
							send('* 1 EXPUNGE');
						}
					}
					send(`${tag} OK ${label} completed`);
				},
			}),
		);
	},
};
