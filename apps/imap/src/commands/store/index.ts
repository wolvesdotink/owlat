import { fn } from '../../convex.js';
import { logger } from '../../logger.js';
import { parseList } from '../../parser.js';
import type { ImapCommandModule } from '../types.js';
import { asyncSession } from '../helpers/session.js';
import { collectMessageIds, inBatches } from '../helpers/uidSet.js';
import { resolveSelectedSet, seqForUid } from '../helpers/seqMap.js';
import { serverFailure } from '../helpers/replies.js';
import { holdSequence } from '../helpers/sequenceGate.js';

export interface StoreArgs {
	readonly set: string;
	readonly unchangedSince?: number;
	readonly silent: boolean;
	readonly mode: 'set' | 'add' | 'remove';
	readonly flagsToken: string;
	readonly byUid: boolean;
}

/**
 * STORE — set / add / remove flags on a UID set. CONDSTORE
 * `UNCHANGEDSINCE` clause optional. `.SILENT` suppresses the per-row
 * `* N FETCH` reply (but the OK still fires).
 */
export const storeModule: ImapCommandModule<StoreArgs> = {
	verbs: ['STORE'],
	capabilities: ['CONDSTORE'],
	requires: 'writable',
	parseArgs(rawArgs) {
		const set = rawArgs[0];
		if (set === undefined) {
			return { ok: false, error: 'STORE requires <set> <op> <flags>' };
		}
		let argIdx = 1;
		let unchangedSince: number | undefined;
		const condStoreToken = rawArgs[argIdx];
		if (condStoreToken?.toUpperCase().startsWith('(UNCHANGEDSINCE')) {
			const m = condStoreToken.match(/UNCHANGEDSINCE\s+(\d+)/i);
			unchangedSince = m ? parseInt(m[1] ?? '', 10) : undefined;
			argIdx += 1;
		}

		const opRaw = rawArgs[argIdx]?.toUpperCase();
		const flagsToken = rawArgs[argIdx + 1];
		if (!opRaw || !flagsToken) {
			return { ok: false, error: 'STORE requires <op> <flags>' };
		}

		const silent = opRaw.endsWith('.SILENT');
		const opCore = silent ? opRaw.slice(0, -7) : opRaw;
		let mode: 'set' | 'add' | 'remove';
		if (opCore === '+FLAGS') mode = 'add';
		else if (opCore === '-FLAGS') mode = 'remove';
		else if (opCore === 'FLAGS') mode = 'set';
		else return { ok: false, error: `Unknown STORE op ${opRaw}` };

		return {
			ok: true,
			args: { set, unchangedSince, silent, mode, flagsToken, byUid: false },
		};
	},
	start({ deps, state, args, tag, send }) {
		const label = args.byUid ? 'UID STORE' : 'STORE';
		const flagList = parseList(args.flagsToken);

		return asyncSession(async () => {
			// Like FETCH: the reply's numbers must stay valid until the OK.
			const lease = holdSequence(deps, args.byUid ? 'sync' : 'shared');
			try {
				await lease.ready;
				// Resolve the set against the folder's sequence ↔ UID map: a
				// non-UID set holds positions, a UID set holds UIDs. The map is
				// reused below to emit each updated row's true sequence number.
				const { seqMap, resolved } = await resolveSelectedSet(
					deps,
					state,
					args.set,
					args.byUid,
					send,
					lease
				);
				lease.downgrade();
				if (resolved.length === 0) {
					send(`${tag} OK ${label} completed`);
					return;
				}

				const messageIds = await collectMessageIds(deps.convex, state.selected!.folderId, resolved);
				if (messageIds.length === 0) {
					send(`${tag} OK ${label} completed`);
					return;
				}

				// Batched: a set over a large folder exceeds what one Convex call
				// accepts. Neither RFC 3501 nor RFC 9051 asks STORE to be atomic;
				// if a later batch fails, the rows it did not reach keep their
				// flags and the updates already sent stand.
				const modified: number[] = [];
				for (const batch of inBatches(messageIds)) {
					const result = await deps.convex.mutation(fn.storeFlags, {
						messageIds: batch,
						flags: flagList,
						mode: args.mode,
						unchangedSinceModseq: args.unchangedSince,
					});

					if (!args.silent) {
						for (const u of result.updated) {
							const seq = seqForUid(seqMap, u.uid) ?? 0;
							send(
								`* ${seq} FETCH (UID ${u.uid} MODSEQ (${u.modseq}) FLAGS (${u.flags.join(' ')}))`
							);
						}
					}

					// RFC 7162 §3.1.3: MODIFIED carries a UID set for UID STORE and a
					// message (sequence) set for plain STORE, the same addressing the
					// client used in the command.
					for (const u of result.unchanged) {
						const id = args.byUid ? u.uid : seqForUid(seqMap, u.uid);
						if (id !== undefined) modified.push(id);
					}
				}
				if (modified.length > 0) {
					send(`${tag} OK [MODIFIED ${modified.join(',')}] ${label} completed`);
					return;
				}
				send(`${tag} OK ${label} completed`);
			} catch (err) {
				logger.error({ err }, 'STORE failed');
				send(serverFailure(tag, label));
			} finally {
				lease.release();
			}
		});
	},
};
