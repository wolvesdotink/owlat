/**
 * THE LEDGER — entries nothing can start, written down as pre-existing debt.
 * Exact in both directions: a new orphan fails until it is registered, called
 * or deleted; a listed entry that gains a caller or is deleted fails until its
 * line comes off. Empty, and the empty state is the point (issue #528).
 * `check-entry-wiring.ts` holds it exact; kept in its own file so a lane that
 * wires an entry edits data, not the walk.
 */
export const UNREACHED_ENTRIES: readonly string[] = [
	// Thread brief: wired by the wiring and web lanes, which delete each line (none may survive).
	'mail/interpret/scope.ts#loadSourceForScope',
	// AI routing (ADR-0073): `get` and `update` are wired by the web lane (the
	// routing-policy panel), which deletes each line; none may survive the branch.
	// (`getResolved` is read by the Team security scan.)
	'aiRouting/policy.ts#get',
	'aiRouting/policy.ts#update',
	// Embedding provenance (ADR-0073, embed lane): the settings page's embedding
	// section (U1) calls the public entries; the web lane deletes each line it
	// wires. The internal page walkers are reached only through those public
	// entries, so their lines go with them.
	'aiRouting/embeddingAttestations.ts#applyPage',
	'aiRouting/embeddingAttestations.ts#attest',
	'aiRouting/embeddingAttestations.ts#revoke',
	'aiRouting/embeddingAttestations.ts#revokePage',
	'aiRouting/embeddingCoverage.ts#refresh',
	'aiRouting/embeddingReembed.ts#startReembed',
	'aiRouting/embeddingRebuild.ts#activateStaged',
	'aiRouting/embeddingRebuild.ts#startRebuild',
	'aiRouting/embeddingRebuild.ts#validateStaged',
	'aiRouting/embeddingRebuildState.ts#cancelRebuild',
	'aiRouting/embeddingRebuildState.ts#catchUpRebuild',
	'aiRouting/embeddingRebuildState.ts#rollback',
	'aiRouting/embeddingReembedJobs.ts#cancelReembed',
	'aiRouting/embeddingReembedJobs.ts#resumeReembed',
	'aiRouting/embeddingSpaces.ts#status',
];
