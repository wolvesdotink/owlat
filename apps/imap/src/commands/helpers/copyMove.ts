/**
 * Shared body for COPY (RFC 3501) and MOVE (RFC 6851). Both resolve the
 * target folder, resolve the message set against the source folder's
 * seq ↔ UID map (sequence numbers for COPY / MOVE, UIDs for the UID
 * variants), collect the affected message ids and run their respective
 * mutation; they diverge only in that mutation and in how the result is
 * emitted (COPY folds `[COPYUID …]` into its tagged completion; MOVE emits
 * untagged `* OK [COPYUID …] Move` + `* n EXPUNGE` lines and then a plain
 * tagged completion). The `emit` callback owns the divergent tail and gets
 * the seq map so MOVE can report true sequence numbers.
 */

import type { CopyMoveResult, fn } from '../../convex.js';
import { logger } from '../../logger.js';
import type { CommandDeps, ConnectionState } from '../types.js';
import { resolveFolderByName } from './folders.js';
import { resolveSelectedSet, type SeqMap } from './seqMap.js';
import { collectMessageIds } from './uidSet.js';
import { serverFailure } from './replies.js';

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
	/** The Convex mutation reference (`fn.copyMessages` / `fn.moveMessages`). */
	readonly mutation: typeof fn.copyMessages | typeof fn.moveMessages;
	readonly send: (line: string) => void;
	/** Emits the success responses for this verb; `seqMap` is the source folder's. */
	readonly emit: (result: CopyMoveResult, seqMap: SeqMap) => void;
}

export async function runCopyOrMove(params: RunCopyOrMoveParams): Promise<void> {
	const { deps, state, set, byUid, target, tag, label, verb, mutation, send, emit } = params;
	try {
		const targetFolder = await resolveFolderByName(deps.convex, state.auth!.mailboxId, target);
		if (!targetFolder) {
			send(`${tag} NO [TRYCREATE] Mailbox not found`);
			return;
		}

		const { seqMap, resolved } = await resolveSelectedSet(deps, state, set, byUid, send);
		const messageIds = await collectMessageIds(deps.convex, state.selected!.folderId, resolved);
		if (messageIds.length === 0) {
			send(`${tag} OK ${label} completed`);
			return;
		}

		const result = await deps.convex.mutation(mutation, {
			sourceFolderId: state.selected!.folderId,
			targetFolderId: targetFolder._id,
			messageIds,
		});

		emit(result, seqMap);
	} catch (err) {
		logger.error({ err }, `${verb} failed`);
		send(serverFailure(tag, label));
	}
}
