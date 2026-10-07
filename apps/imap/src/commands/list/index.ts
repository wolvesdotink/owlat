import type { ImapCommandModule } from '../types.js';
import { asyncSession } from '../helpers/session.js';
import { listImapFolders } from '../helpers/folders.js';
import { flagsForFolder } from '../helpers/folderFlags.js';
import { logger } from '../../logger.js';
import { serverFailure } from '../helpers/replies.js';
import { imapMailboxName } from '../helpers/mailboxName.js';
import { DELIMITER, type ImapFolder } from '../helpers/folderTree.js';
import { matchesPattern, pathFromClient } from '../helpers/mailboxPattern.js';

interface ListArgs {
	readonly reference: string;
	readonly pattern: string;
}

/**
 * LIST and LSUB share one module (RFC 3501 §6.3.8, §6.3.9). The reference and
 * the mailbox pattern are joined into one pattern over the folder paths
 * (`folderTree.ts`); LSUB keeps the subscribed folders of what matches. The
 * verb arrives in `start({ verb })` so the response label and filter both
 * branch off it.
 *
 * Only the RFC 3501 form is accepted. LIST-EXTENDED (RFC 5258) and
 * LIST-STATUS (RFC 5819) are not advertised: clients without them read
 * subscriptions with LSUB and counts with STATUS.
 */
export const listModule: ImapCommandModule<ListArgs> = {
	verbs: ['LIST', 'LSUB'],
	capabilities: ['SPECIAL-USE'],
	requires: 'auth',
	concurrent: () => true,
	parseArgs(rawArgs) {
		const [reference, pattern] = rawArgs;
		if (rawArgs.length !== 2 || reference === undefined || pattern === undefined) {
			return { ok: false, error: 'LIST and LSUB take <reference> <mailbox>' };
		}
		return { ok: true, args: { reference, pattern } };
	},
	start({ deps, state, args, tag, verb, send }) {
		return asyncSession(async () => {
			try {
				// An empty pattern asks for the delimiter and the root of the
				// reference's hierarchy, which is "" for every name here.
				if (args.pattern === '') {
					if (verb === 'LIST') send(`* LIST (\\Noselect) "${DELIMITER}" ""`);
					send(`${tag} OK ${verb} completed`);
					return;
				}
				const pattern = pathFromClient(args.reference + args.pattern);
				const folders = await listImapFolders(deps.convex, state.auth!.mailboxId);
				for (const f of folders) {
					if (!matchesPattern(pattern, f.path)) continue;
					const flags =
						verb === 'LIST' || f.subscribed
							? flagsForFolder(f.role, f.hasChildren)
							: lsubPlaceholder(f, folders, pattern);
					if (flags === null) continue;
					send(`* ${verb} (${flags}) "${DELIMITER}" ${imapMailboxName(f.path)}`);
				}
				send(`${tag} OK ${verb} completed`);
			} catch (err) {
				logger.error({ err }, `${verb} failed`);
				send(serverFailure(tag, verb));
			}
		});
	},
};

/**
 * An unsubscribed folder in LSUB. RFC 3501 §6.3.9: when `%` stops at a level
 * whose folder is not subscribed while a subscribed folder below it is out of
 * the pattern's reach, that level is returned with `\Noselect`, so the client
 * can still find what is below it. Otherwise it is left out.
 */
function lsubPlaceholder(
	folder: ImapFolder,
	folders: readonly ImapFolder[],
	pattern: string
): string | null {
	if (!pattern.includes('%') || !folder.hasChildren) return null;
	const below = folder.path + DELIMITER;
	const hidden = folders.some(
		(f) => f.subscribed && f.path.startsWith(below) && !matchesPattern(pattern, f.path)
	);
	return hidden ? '\\Noselect' : null;
}
