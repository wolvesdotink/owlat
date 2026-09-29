/**
 * Shared body for COPY (RFC 3501) and MOVE (RFC 6851). Both resolve the
 * target folder, resolve the message set against the source folder's
 * seq ↔ UID map (sequence numbers for COPY / MOVE, UIDs for the UID
 * variants) and collect the affected message ids; they diverge in the
 * mutation they run and in how the result is emitted (COPY folds
 * `[COPYUID …]` into its tagged completion; MOVE emits untagged
 * `* OK [COPYUID …] Move` + `* n EXPUNGE` lines and then a plain tagged
 * completion). The `apply` callback owns that divergent tail and gets the
 * seq map so MOVE can report true sequence numbers.
 *
 * A set can span a whole folder, and Convex caps an array argument at 8,192
 * elements, so `apply` sends the ids in batches (`inBatches`). The message ids
 * arrive in ascending UID order.
 */

import { logger } from '../../logger.js';
import type { CommandDeps, ConnectionState } from '../types.js';
import { resolveFolderByName } from './folders.js';
import { resolveSelectedSet, type SeqMap } from './seqMap.js';
import { collectMessageIds } from './uidSet.js';
import { serverFailure } from './replies.js';

/** What `apply` works on: the resolved source messages and the target folder. */
export interface CopyMoveBatchInput {
	readonly sourceFolderId: string;
	readonly targetFolderId: string;
	/** Source message ids, ascending by UID. Never empty. */
	readonly messageIds: string[];
	/** The source folder's seq map the set was resolved against. */
	readonly seqMap: SeqMap;
}

export interface RunCopyOrMoveParams {
	readonly deps: CommandDeps;
	readonly state: ConnectionState;
	readonly set: string;
	/** `true` for UID COPY / UID MOVE: the set holds UIDs, not sequence numbers. */
	readonly byUid: boolean;
	readonly target: string;
	readonly tag: string;
	/** The command as the client sent it (`COPY`, `UID MOVE`, …), used in every reply. */
	readonly label: string;
	/** Verb name, used in the log context. */
	readonly verb: 'COPY' | 'MOVE';
	readonly send: (line: string) => void;
	/**
	 * Runs the verb and sends its success responses, including the tagged OK.
	 * Throwing answers the command with a server failure.
	 */
	readonly apply: (input: CopyMoveBatchInput) => Promise<void>;
}

export async function runCopyOrMove(params: RunCopyOrMoveParams): Promise<void> {
	const { deps, state, set, byUid, target, tag, label, verb, send, apply } = params;
	try {
		const targetFolder = await resolveFolderByName(deps.convex, state.auth!.mailboxId, target);
		if (!targetFolder) {
			send(`${tag} NO [TRYCREATE] Mailbox not found`);
			return;
		}

		const { seqMap, resolved } = await resolveSelectedSet(deps, state, set, byUid);
		const messageIds = await collectMessageIds(
			deps.convex,
			state.selected!.folderId,
			resolved.map((r) => r.uid)
		);
		if (messageIds.length === 0) {
			send(`${tag} OK ${label} completed`);
			return;
		}

		await apply({
			sourceFolderId: state.selected!.folderId,
			targetFolderId: targetFolder._id,
			messageIds,
			seqMap,
		});
	} catch (err) {
		logger.error({ err }, `${verb} failed`);
		send(serverFailure(tag, label));
	}
}
