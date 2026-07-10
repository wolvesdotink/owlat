import { fn } from '../../convex.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { requireAuth, requireSelect, requireWritableSelect } from '../helpers/auth.js';
import { runCopyOrMove } from '../helpers/copyMove.js';

export interface CopyArgs {
	readonly set: string;
	readonly target: string;
	readonly byUid: boolean;
}

export const copyModule: ImapCommandModule<CopyArgs> = {
	verbs: ['COPY'],
	parseArgs(rawArgs) {
		const [set, target] = rawArgs;
		if (!set || !target) {
			return { ok: false, error: 'COPY requires <set> <target>' };
		}
		return { ok: true, args: { set, target, byUid: false } };
	},
	start({ deps, state, args, tag, send }) {
		const fail =
			requireAuth(state, tag) ?? requireSelect(state, tag) ?? requireWritableSelect(state, tag);
		if (fail) {
			send(fail);
			return syncSession();
		}

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
