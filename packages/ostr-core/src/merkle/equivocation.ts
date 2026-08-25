/**
 * The §9.1 gossip check, in one place: given two signed tree heads from one
 * log, has the log shown two different histories?
 *
 * A monitor holds heads as published — `rootHash` is hex — while
 * {@link verifyConsistency} works on raw digests, so the hex/bytes step lives
 * here too rather than in every monitor.
 *
 * Both heads must carry the log's own signature to be evidence of anything; an
 * unsigned pair is a story about a log, not a finding against it. The verdict
 * is deliberately a closed set of strings: `split-view` and
 * `inconsistent-extension` are publishable as an `audit-finding`, `unproven`
 * only means the log has not been asked for a consistency proof yet.
 */

import { verifyConsistency } from './proof.js';
import { parseHash } from './hex.js';
import { verifyTreeHead, type SignedTreeHead } from './sth.js';

export type EquivocationVerdict =
	/** At least one head is not signed by this log — no evidence either way. */
	| 'unsigned'
	/** Heads from two different logs; nothing to compare. */
	| 'not-comparable'
	/** Sizes differ and no consistency proof was supplied. */
	| 'unproven'
	/** The two heads describe one append-only history. */
	| 'consistent'
	/** Same tree size, different root: proof of equivocation. */
	| 'split-view'
	/** Sizes differ and the log's own consistency proof does not check out. */
	| 'inconsistent-extension';

export interface EquivocationCheckInput {
	readonly a: SignedTreeHead;
	readonly b: SignedTreeHead;
	/** The log's raw 32-byte ed25519 public key, base64. */
	readonly publicKeyBase64: string;
	/**
	 * Consistency proof from the smaller head to the larger one, as served by
	 * the log. Omitted when the log has not been asked (or refused) — the
	 * verdict is then `unproven`, which is a reason to keep asking, not a
	 * finding.
	 */
	readonly consistencyProof?: readonly Uint8Array[];
}

/**
 * Compare two heads of one log. Never throws: every input arrives from a
 * gossip peer.
 */
export function detectEquivocation(input: EquivocationCheckInput): EquivocationVerdict {
	const { a, b, publicKeyBase64, consistencyProof } = input;
	if (!verifyTreeHead(a, publicKeyBase64) || !verifyTreeHead(b, publicKeyBase64)) {
		return 'unsigned';
	}
	if (a.logId !== b.logId) return 'not-comparable';

	if (a.treeSize === b.treeSize) {
		return a.rootHash === b.rootHash ? 'consistent' : 'split-view';
	}

	const [older, newer] = a.treeSize < b.treeSize ? [a, b] : [b, a];
	if (consistencyProof === undefined) return 'unproven';
	const oldRoot = parseHash(older.rootHash);
	const newRoot = parseHash(newer.rootHash);
	// Both heads verified, so both root hashes parse; the guard is for the type.
	if (oldRoot === undefined || newRoot === undefined) return 'unsigned';
	const consistent = verifyConsistency({
		oldSize: older.treeSize,
		newSize: newer.treeSize,
		oldRoot,
		newRoot,
		proof: consistencyProof,
	});
	return consistent ? 'consistent' : 'inconsistent-extension';
}

/** True only for verdicts that stand up as an `audit-finding` against the log. */
export function isEquivocationProven(verdict: EquivocationVerdict): boolean {
	return verdict === 'split-view' || verdict === 'inconsistent-extension';
}
