/**
 * A fake {@link RegistryLog} for the aggregator tests: real attestations,
 * really signed with generated ed25519 keys, sequenced into a real Merkle tree
 * with a real signed head. Only the submission path is absent — the aggregator
 * never writes to the log, and the fake refuses it loudly rather than pretending.
 */

import { canonicalBytes } from '@owlat/ostr-core';
import { MerkleTree, signTreeHead, toHex } from '@owlat/ostr-core/merkle';
import type { SequencedAttestation, SignedTreeHead } from '@owlat/ostr-core';
import type { RegistryLog, SubmitOutcome } from '../../contracts.js';

export const LOG_ID = 'https://log.test/ostr';

export class FakeLog implements RegistryLog {
	readonly #entries: SequencedAttestation[] = [];
	readonly #tree = new MerkleTree();
	readonly #privateKey: string;
	#head: SignedTreeHead | null = null;

	constructor(privateKeyBase64: string) {
		this.#privateKey = privateKeyBase64;
	}

	/** Append already-signed attestations, assigning log coordinates. */
	append(entries: readonly Omit<SequencedAttestation, 'logId' | 'index'>[]): void {
		for (const entry of entries) {
			const index = this.#tree.append(canonicalBytes(entry.attestation));
			this.#entries.push({
				logId: LOG_ID,
				index,
				loggedAt: entry.loggedAt,
				attestation: entry.attestation,
			});
		}
	}

	async submit(): Promise<SubmitOutcome> {
		throw new Error('the aggregator must not write to the log');
	}

	async size(): Promise<number> {
		return this.#entries.length;
	}

	async head(): Promise<SignedTreeHead | null> {
		return this.#head;
	}

	async publishHead(timestamp: string): Promise<SignedTreeHead> {
		this.#head = signTreeHead(
			{
				logId: LOG_ID,
				treeSize: this.#tree.size,
				rootHash: toHex(this.#tree.root()),
				timestamp,
			},
			this.#privateKey
		);
		return this.#head;
	}

	async entries(start: number, count: number): Promise<SequencedAttestation[]> {
		return this.#entries.slice(start, start + count);
	}

	async entry(index: number): Promise<SequencedAttestation | null> {
		return this.#entries[index] ?? null;
	}

	async inclusionProof(index: number, treeSize: number): Promise<string[]> {
		return this.#tree.inclusionProof(index, treeSize).map(toHex);
	}

	async consistencyProof(oldSize: number, newSize: number): Promise<string[]> {
		return this.#tree.consistencyProof(oldSize, newSize).map(toHex);
	}
}
