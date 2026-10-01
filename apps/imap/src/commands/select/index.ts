import type { ImapCommandModule, SelectedState } from '../types.js';
import { asyncSession } from '../helpers/session.js';
import { resolveFolderByName } from '../helpers/folders.js';
import { fn } from '../../convex.js';
import { logger } from '../../logger.js';
import { serverFailure } from '../helpers/replies.js';
import { loadCurrentUids } from '../helpers/membership.js';
import { seqForUid } from '../helpers/seqMap.js';

interface SelectArgs {
	readonly mailboxName: string;
}

/**
 * SELECT and EXAMINE share one module — EXAMINE is "SELECT but read-only,"
 * so the only difference is the `readOnly` flag on the resulting
 * SelectedState and the `[READ-ONLY] / [READ-WRITE]` tag in the OK
 * response.
 */
export const selectModule: ImapCommandModule<SelectArgs> = {
	verbs: ['SELECT', 'EXAMINE'],
	requires: 'auth',
	parseArgs(rawArgs) {
		const name = rawArgs[0];
		if (!name) {
			return { ok: false, error: 'SELECT requires a mailbox name' };
		}
		return { ok: true, args: { mailboxName: name } };
	},
	start({ deps, state, args, tag, verb, send }) {
		const readOnly = verb === 'EXAMINE';

		return asyncSession(async (signal) => {
			try {
				const target = await resolveFolderByName(
					deps.convex,
					state.auth!.mailboxId,
					args.mailboxName
				);
				if (!target) {
					send(`${tag} NO Mailbox not found`);
					return;
				}

				const result = await deps.convex.query(fn.selectFolder, {
					folderId: target._id,
					skipFirstUnseenSeq: true,
				});

				if (!result) {
					send(`${tag} NO Mailbox not found`);
					return;
				}
				// The client's sequence view starts as the folder is now; EXISTS
				// below is its length, so the numbers the client counts from it are
				// the ones the server resolves against (see `SequenceView`).
				const uids = await loadCurrentUids(deps.convex, result.folder._id, signal);

				const selected: SelectedState = {
					folderId: result.folder._id,
					folderName: result.folder.name,
					role: result.folder.role,
					uidValidity: result.folder.uidValidity,
					uidNext: result.folder.uidNext,
					highestModseq: result.folder.highestModseq,
					totalCount: uids.length,
					readOnly,
					view: { uids },
				};

				send(`* ${uids.length} EXISTS`);
				send(`* 0 RECENT`);
				send(`* OK [UIDVALIDITY ${result.folder.uidValidity}] UIDs valid`);
				send(`* OK [UIDNEXT ${result.folder.uidNext}] Predicted next UID`);
				send(`* OK [HIGHESTMODSEQ ${result.folder.highestModseq}] Highest`);
				// RFC 3501 §7.1: `[UNSEEN n]` is the message *sequence number* of
				// the first unseen message, not its UID.
				const firstUnseenSeq =
					result.firstUnseenUid == null ? undefined : seqForUid({ uids }, result.firstUnseenUid);
				if (firstUnseenSeq != null) {
					send(`* OK [UNSEEN ${firstUnseenSeq}] First unseen`);
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
					send('* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] Limited');
				}
				deps.commit({ ...state, selected });
				send(`${tag} OK [${readOnly ? 'READ-ONLY' : 'READ-WRITE'}] ${verb} completed`);
			} catch (err) {
				logger.error({ err }, 'SELECT failed');
				send(serverFailure(tag, verb));
			}
		});
	},
};
