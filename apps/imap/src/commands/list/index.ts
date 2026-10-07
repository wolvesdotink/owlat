import type { ImapCommandModule } from '../types.js';
import { asyncSession } from '../helpers/session.js';
import { listImapFolders } from '../helpers/folders.js';
import { flagsForFolder } from '../helpers/folderFlags.js';
import { logger } from '../../logger.js';
import { serverFailure } from '../helpers/replies.js';
import { imapMailboxName } from '../helpers/mailboxName.js';
import { DELIMITER, type ImapFolder } from '../helpers/folderTree.js';
import { matchesPattern, pathFromClient, patternOverLimit } from '../helpers/mailboxPattern.js';

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
 * Only the RFC 3501 form is accepted: two mailbox names, each an atom or a
 * string, never a parenthesized list, together within the pattern caps of
 * `mailboxPattern.ts`. LIST-EXTENDED (RFC 5258), LIST-STATUS
 * (RFC 5819) and SPECIAL-USE (RFC 6154, whose capability names the extended
 * LIST options) are not advertised, so clients read subscriptions with LSUB
 * and counts with STATUS. The special-use attributes (`\Sent`, ...) are still
 * sent, which RFC 6154 §2 allows on the plain LIST.
 */
export const listModule: ImapCommandModule<ListArgs> = {
	verbs: ['LIST', 'LSUB'],
	requires: 'auth',
	concurrent: () => true,
	parseArgs(rawArgs, argForms) {
		const [reference, pattern] = rawArgs;
		if (
			rawArgs.length !== 2 ||
			reference === undefined ||
			pattern === undefined ||
			argForms?.includes('list')
		) {
			return { ok: false, error: 'LIST and LSUB take <reference> <mailbox>' };
		}
		const overLimit = patternOverLimit(reference + pattern);
		if (overLimit) return { ok: false, error: `LIST and LSUB refuse a ${overLimit}` };
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
 * An unsubscribed folder in LSUB. RFC 3501 §6.3.9: when a pattern's trailing
 * `%` stops at a level whose folder is not subscribed but has a subscribed
 * folder below it, that level is returned with `\Noselect`, so the client can
 * still find what is below it. Otherwise it is left out.
 */
function lsubPlaceholder(
	folder: ImapFolder,
	folders: readonly ImapFolder[],
	pattern: string
): string | null {
	if (!pattern.endsWith('%') || !folder.hasChildren) return null;
	const below = folder.path + DELIMITER;
	return folders.some((f) => f.subscribed && f.path.startsWith(below)) ? '\\Noselect' : null;
}
