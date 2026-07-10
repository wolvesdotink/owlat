/**
 * Shared body for COPY (RFC 3501) and MOVE (RFC 6851). Both resolve the
 * target folder, parse the UID set, collect the affected message ids and
 * run their respective mutation; they diverge only in that mutation and
 * in how the result is emitted (COPY folds `[COPYUID …]` into its tagged
 * completion; MOVE emits untagged `* OK [COPYUID …] Move` + `* 1 EXPUNGE`
 * lines and then a plain tagged completion). The `emit` callback owns the
 * divergent tail so every response string is threaded through unchanged.
 */

import { logger } from '../../logger.js';
import { parseUidSet } from '../../parser.js';
import type { CommandDeps, ConnectionState } from '../types.js';
import { resolveFolderByName } from './folders.js';
import { collectMessageIds } from './uidSet.js';

/** Result shape returned by both `copyMessages` and `moveMessages`. */
export interface CopyMoveResult {
	readonly uidValidity: number;
	readonly pairs: ReadonlyArray<{ sourceUid: number; targetUid: number }>;
}

export interface RunCopyOrMoveParams {
	readonly deps: CommandDeps;
	readonly state: ConnectionState;
	readonly set: string;
	readonly target: string;
	readonly tag: string;
	readonly label: string;
	/** Verb name, used verbatim in the log context and the BAD response. */
	readonly verb: 'COPY' | 'MOVE';
	/** The Convex mutation reference (`fn.copyMessages` / `fn.moveMessages`). */
	readonly mutation: unknown;
	readonly send: (line: string) => void;
	/** Emits the success responses for this verb. */
	readonly emit: (result: CopyMoveResult) => void;
}

export async function runCopyOrMove(params: RunCopyOrMoveParams): Promise<void> {
	const { deps, state, set, target, tag, label, verb, mutation, send, emit } = params;
	try {
		const targetFolder = await resolveFolderByName(deps.convex, state.auth!.mailboxId, target);
		if (!targetFolder) {
			send(`${tag} NO [TRYCREATE] Mailbox not found`);
			return;
		}

		const ranges = parseUidSet(set, state.selected!.uidNext - 1);
		if (ranges.length === 0) {
			send(`${tag} OK ${label} completed (empty range)`);
			return;
		}

		const messageIds = await collectMessageIds(deps.convex, state.selected!.folderId, ranges);
		if (messageIds.length === 0) {
			send(`${tag} OK ${label} completed`);
			return;
		}

		const result = (await deps.convex.mutation(mutation as never, {
			sourceFolderId: state.selected!.folderId,
			targetFolderId: targetFolder._id,
			messageIds,
		} as never)) as CopyMoveResult;

		emit(result);
	} catch (err) {
		logger.error({ err }, `${verb} failed`);
		send(`${tag} BAD ${verb} failed`);
	}
}
