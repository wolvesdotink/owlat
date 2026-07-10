import { fn } from '../../convex.js';
import { logger } from '../../logger.js';
import { parseUidSet } from '../../parser.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { requireAuth, requireSelect, requireWritableSelect } from '../helpers/auth.js';
import { resolveFolderByName } from '../helpers/folders.js';
import { collectMessageIds } from '../helpers/uidSet.js';

export interface MoveArgs {
	readonly set: string;
	readonly target: string;
	readonly byUid: boolean;
}

interface MoveMessagesResult {
	readonly uidValidity: number;
	readonly pairs: ReadonlyArray<{ sourceUid: number; targetUid: number }>;
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

		return asyncSession(async () => {
			try {
				const targetFolder = await resolveFolderByName(
					deps.convex,
					state.auth!.mailboxId,
					args.target,
				);
				if (!targetFolder) {
					send(`${tag} NO [TRYCREATE] Mailbox not found`);
					return;
				}

				const ranges = parseUidSet(args.set, state.selected!.uidNext - 1);
				if (ranges.length === 0) {
					send(`${tag} OK ${label} completed (empty range)`);
					return;
				}

				const messageIds = await collectMessageIds(
					deps.convex,
					state.selected!.folderId,
					ranges,
				);
				if (messageIds.length === 0) {
					send(`${tag} OK ${label} completed`);
					return;
				}

				const result = (await deps.convex.mutation(fn.moveMessages as never, {
					sourceFolderId: state.selected!.folderId,
					targetFolderId: targetFolder._id,
					messageIds,
				} as never)) as MoveMessagesResult;

				if (result.pairs.length > 0) {
					const sources = result.pairs.map((p) => p.sourceUid).join(',');
					const targets = result.pairs.map((p) => p.targetUid).join(',');
					send(`* OK [COPYUID ${result.uidValidity} ${sources} ${targets}] Move`);
					for (const _ of result.pairs) {
						send('* 1 EXPUNGE');
					}
				}
				send(`${tag} OK ${label} completed`);
			} catch (err) {
				logger.error({ err }, 'MOVE failed');
				send(`${tag} BAD MOVE failed`);
			}
		});
	},
};
