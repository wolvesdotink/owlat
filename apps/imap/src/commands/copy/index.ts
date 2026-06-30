import { fn } from '../../convex.js';
import { logger } from '../../logger.js';
import { parseUidSet } from '../../parser.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { requireAuth, requireSelect } from '../helpers/auth.js';
import { resolveFolderByName } from '../helpers/folders.js';
import { collectMessageIds } from '../helpers/uidSet.js';

export interface CopyArgs {
	readonly set: string;
	readonly target: string;
	readonly byUid: boolean;
}

interface CopyMessagesResult {
	readonly uidValidity: number;
	readonly pairs: ReadonlyArray<{ sourceUid: number; targetUid: number }>;
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
		const fail = requireAuth(state, tag) ?? requireSelect(state, tag);
		if (fail) {
			send(fail);
			return syncSession();
		}
		if (state.selected!.readOnly) {
			send(`${tag} NO Mailbox is read-only`);
			return syncSession();
		}

		const label = args.byUid ? 'UID COPY' : 'COPY';

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

				const result = (await deps.convex.mutation(fn.copyMessages as never, {
					sourceFolderId: state.selected!.folderId,
					targetFolderId: targetFolder._id,
					messageIds,
				} as never)) as CopyMessagesResult;

				if (result.pairs.length > 0) {
					const sources = result.pairs.map((p) => p.sourceUid).join(',');
					const targets = result.pairs.map((p) => p.targetUid).join(',');
					send(`${tag} OK [COPYUID ${result.uidValidity} ${sources} ${targets}] ${label} completed`);
					return;
				}
				send(`${tag} OK ${label} completed`);
			} catch (err) {
				logger.error({ err }, 'COPY failed');
				send(`${tag} BAD COPY failed`);
			}
		});
	},
};
