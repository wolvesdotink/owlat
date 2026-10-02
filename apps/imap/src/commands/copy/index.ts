import { fn, type ConvexClient } from '../../convex.js';
import { logger } from '../../logger.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession } from '../helpers/session.js';
import { runCopyOrMove } from '../helpers/copyMove.js';
import { inBatches } from '../helpers/uidSet.js';

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
 *
 * A large set is copied in batches. COPY must leave the target folder as it
 * was when it fails (RFC 3501 §6.4.7, RFC 9051 §6.4.7), so when a batch fails
 * the copies the earlier batches made are removed again before the command
 * answers NO; only UIDNEXT stays advanced, which both RFCs allow.
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
				byUid: args.byUid,
				target: args.target,
				tag,
				label,
				verb: 'COPY',
				send,
				apply: async ({ sourceFolderId, targetFolderId, messageIds }) => {
					const pairs: Array<{ sourceUid: number; targetUid: number }> = [];
					let uidValidity = 0;
					try {
						for (const batch of inBatches(messageIds)) {
							const result = await deps.convex.mutation(fn.copyMessages, {
								sourceFolderId,
								targetFolderId,
								messageIds: batch,
							});
							uidValidity = result.uidValidity;
							for (const pair of result.pairs) pairs.push(pair);
						}
					} catch (err) {
						await discardCopies(deps.convex, targetFolderId, pairs);
						throw err;
					}

					if (pairs.length > 0) {
						const sources = pairs.map((p) => p.sourceUid).join(',');
						const targets = pairs.map((p) => p.targetUid).join(',');
						send(`${tag} OK [COPYUID ${uidValidity} ${sources} ${targets}] ${label} completed`);
						return;
					}
					send(`${tag} OK ${label} completed`);
				},
			})
		);
	},
};

/** Remove the copies a failed COPY already made. A failure here is logged. */
async function discardCopies(
	convex: ConvexClient,
	targetFolderId: string,
	pairs: ReadonlyArray<{ targetUid: number }>
): Promise<void> {
	try {
		for (const batch of inBatches(pairs.map((p) => p.targetUid))) {
			await convex.mutation(fn.discardCopies, { targetFolderId, uids: batch });
		}
	} catch (err) {
		logger.error({ err, copied: pairs.length }, 'COPY failed and its partial copy remains');
	}
}
