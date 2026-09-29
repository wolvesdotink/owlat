import { fn } from '../../convex.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession } from '../helpers/session.js';
import { runCopyOrMove } from '../helpers/copyMove.js';

interface CopyArgs {
	readonly set: string;
	readonly target: string;
	readonly byUid: boolean;
}

/**
 * COPY (RFC 3501 §6.4.7) — copy messages from the selected folder into
 * another one. It only reads the source, so it runs on an EXAMINEd
 * (read-only) folder too; MOVE, which removes the source messages,
 * requires a writable selection.
 */
export const copyModule: ImapCommandModule<CopyArgs> = {
	verbs: ['COPY'],
	requires: 'selected',
	parseArgs(rawArgs) {
		const [set, target] = rawArgs;
		if (!set || !target) {
			return { ok: false, error: 'COPY requires <set> <target>' };
		}
		return { ok: true, args: { set, target, byUid: false } };
	},
	start({ deps, state, args, tag, send }) {
		const label = args.byUid ? 'UID COPY' : 'COPY';

		return asyncSession(() =>
			runCopyOrMove({
				deps,
				state,
				set: args.set,
				target: args.target,
				tag,
				label,
				verb: 'COPY',
				mutation: fn.copyMessages,
				send,
				emit: (result) => {
					if (result.pairs.length > 0) {
						const sources = result.pairs.map((p) => p.sourceUid).join(',');
						const targets = result.pairs.map((p) => p.targetUid).join(',');
						send(
							`${tag} OK [COPYUID ${result.uidValidity} ${sources} ${targets}] ${label} completed`
						);
						return;
					}
					send(`${tag} OK ${label} completed`);
				},
			})
		);
	},
};
