/**
 * READING A STORED `providerDetails` BLOB, STATED ONCE.
 *
 * The one field of `sendingDomainRelayIdentities` the table keeps deliberately
 * OPAQUE: each relay kind builds its own versioned payload, so the shape is the
 * adapter's business (see `./relayIdentityPersistence.ts`) — but what counts as a
 * blob we are willing to read at all is the TABLE's, and every kind has to answer
 * it identically. Reject a parse failure, reject `null`, reject an array, and
 * hand back a record the caller picks its own fields out of.
 *
 * ITS OWN LEAF FILE, and that is the whole point. Both readers need it and they
 * cannot share a home: `./relayIdentityPersistence.ts` resolves the singleton
 * organization and takes a `MutationCtx`, while the plugin tier's reader lives in
 * `./plugin/state.ts`, which is deliberately free of every Convex runtime import
 * so that the judgements it makes about an UNTRUSTED module's output can be
 * pinned by a plain unit test. Leaving a second hand-rolled copy in `state.ts`
 * was the alternative, and it is the failure this file's neighbours argue
 * against: a later hardening here (refusing an oversized blob, or one whose
 * `kind` disagrees with the row's `providerKind`) would then apply to the tier
 * that writes a failure reason and not to the tier that hands DNS facts to the
 * alignment pre-flight, from one row.
 */

/**
 * Best-effort read of a stored blob; `{}` on anything odd.
 *
 * NEVER THROWS, on purpose. The callers are a failure-path write merging a
 * reason into what it already holds and a read describing a reference arm —
 * neither has a useful answer to "the row's own payload is corrupt", and both
 * degrade correctly to "we know nothing extra about this domain", which the
 * surfaces downstream already read as a hold rather than as a pass.
 */
export function parseStoredProviderDetails(raw: string | undefined): Record<string, unknown> {
	if (raw === undefined) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
