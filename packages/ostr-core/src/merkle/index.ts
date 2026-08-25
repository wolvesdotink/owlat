/**
 * Merkle module: RFC 6962/9162 hashing, an append-only tree with inclusion and
 * consistency proofs, signed tree heads, the inclusion promises submissions get
 * before a head covers them, the pairwise equivocation check monitors gossip
 * for, and the §7.2 evidence-batch commitments used for challenge sampling
 * (see TRUST_REGISTRY_PLAN §9.1, D1).
 *
 * Proof generation needs a tree; proof verification never does.
 *
 * The tree/proof index arithmetic (`splitPoint`, `isPowerOfTwo`, hash-list
 * predicates) stays internal to `./hash.js`: it is the implementation of the
 * RFC's recursion, not API a log or a monitor should depend on.
 */

export { emptyTreeRoot, HASH_LENGTH, leafHash, nodeHash } from './hash.js';
export { parseHash, toHex } from './hex.js';
export { MerkleTree } from './tree.js';
export {
	verifyConsistency,
	verifyInclusion,
	type ConsistencyProofInput,
	type InclusionProofInput,
} from './proof.js';
export {
	signTreeHead,
	STH_SIGNATURE_TYPE,
	treeHeadSigningBytes,
	verifyTreeHead,
	type SignedTreeHead,
	type UnsignedTreeHead,
} from './sth.js';
export {
	detectEquivocation,
	isEquivocationProven,
	type EquivocationCheckInput,
	type EquivocationVerdict,
} from './equivocation.js';
export {
	inclusionDeadline,
	INCLUSION_PROMISE_TYPE,
	inclusionPromiseCoversLeaf,
	inclusionPromiseSigningBytes,
	signInclusionPromise,
	verifyInclusionPromise,
	type SignedInclusionPromise,
	type UnsignedInclusionPromise,
} from './promise.js';
export {
	commitToBundles,
	openBundles,
	verifyBundleOpening,
	type BatchCommitment,
	type BundleOpening,
	type BundleOpeningInput,
} from './batch.js';
