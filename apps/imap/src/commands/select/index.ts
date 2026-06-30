import type { ImapCommandModule, SelectedState } from '../types.js';
import { asyncSession, syncSession } from '../helpers/session.js';
import { requireAuth } from '../helpers/auth.js';
import { resolveFolderByName } from '../helpers/folders.js';
import { fn } from '../../convex.js';
import { logger } from '../../logger.js';

interface SelectArgs {
	readonly mailboxName: string;
}

interface SelectFolderResult {
	folder: {
		_id: string;
		name: string;
		role?: string;
		uidValidity: number;
		uidNext: number;
		highestModseq: number;
		totalCount: number;
		unseenCount: number;
	};
	firstUnseenUid?: number;
	firstUnseenSeq?: number;
}

/**
 * SELECT and EXAMINE share one module — EXAMINE is "SELECT but read-only,"
 * so the only difference is the `readOnly` flag on the resulting
 * SelectedState and the `[READ-ONLY] / [READ-WRITE]` tag in the OK
 * response.
 */
export const selectModule: ImapCommandModule<SelectArgs> = {
	verbs: ['SELECT', 'EXAMINE'],
	parseArgs(rawArgs) {
		const name = rawArgs[0];
		if (!name) {
			return { ok: false, error: 'SELECT requires a mailbox name' };
		}
		return { ok: true, args: { mailboxName: name } };
	},
	start({ deps, state, args, tag, verb, send }) {
		const fail = requireAuth(state, tag);
		if (fail) {
			send(fail);
			return syncSession();
		}

		const readOnly = verb === 'EXAMINE';

		return asyncSession(async () => {
			try {
				const target = await resolveFolderByName(
					deps.convex,
					state.auth!.mailboxId,
					args.mailboxName,
				);
				if (!target) {
					send(`${tag} NO Mailbox not found`);
					return;
				}

				const result = (await deps.convex.query(fn.selectFolder as never, {
					folderId: target._id,
				} as never)) as SelectFolderResult | null;

				if (!result) {
					send(`${tag} NO Mailbox not found`);
					return;
				}

				const selected: SelectedState = {
					folderId: result.folder._id,
					folderName: result.folder.name,
					role: result.folder.role,
					uidValidity: result.folder.uidValidity,
					uidNext: result.folder.uidNext,
					highestModseq: result.folder.highestModseq,
					totalCount: result.folder.totalCount,
					readOnly,
				};

				send(`* ${result.folder.totalCount} EXISTS`);
				send(`* 0 RECENT`);
				send(`* OK [UIDVALIDITY ${result.folder.uidValidity}] UIDs valid`);
				send(`* OK [UIDNEXT ${result.folder.uidNext}] Predicted next UID`);
				send(`* OK [HIGHESTMODSEQ ${result.folder.highestModseq}] Highest`);
				// RFC 3501 §7.1: `[UNSEEN n]` is the message *sequence number* of
				// the first unseen message, not its UID.
				if (result.firstUnseenSeq != null) {
					send(`* OK [UNSEEN ${result.firstUnseenSeq}] First unseen`);
				}
				send('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
				if (readOnly) {
					// EXAMINE: the mailbox is opened read-only, so no flags can be
					// stored permanently. RFC 3501 §6.3.2.
					send('* OK [PERMANENTFLAGS ()] No permanent flags (read-only)');
				} else {
					// SELECT: STORE is implemented, so advertise the writable
					// system flags plus `\*` (the client may create new keywords).
					// RFC 3501 §7.1.
					send(
						'* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] Limited',
					);
				}
				deps.commit({ ...state, selected });
				send(
					`${tag} OK [${readOnly ? 'READ-ONLY' : 'READ-WRITE'}] ${verb} completed`,
				);
			} catch (err) {
				logger.error({ err }, 'SELECT failed');
				send(`${tag} BAD ${verb} failed`);
			}
		});
	},
};
