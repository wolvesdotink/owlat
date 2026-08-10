/**
 * THE FAIL-CLOSED DEFAULTS, in one place — the reading half of the send-provider
 * catalog (the seams plan's D1).
 *
 * Every capability field on {@link SendProviderCatalogEntryShape} is optional,
 * and each one's ABSENT value means something: see the field's own docblock in
 * `./sendProviderCatalogTypes`, which is where the rule is argued. This module
 * is that argument in code, so the documentation and the behaviour cannot drift
 * and no consumer restates a `?? false`.
 *
 * THEY TAKE AN ENTRY, NOT A KIND, because the lookup differs by caller and the
 * rule does not. The backend's kind-keyed `…For(kind)` accessors
 * (`apps/api/convex/lib/sendProviders/catalog.ts`) resolve against the COMPOSED
 * catalog — core entries plus the bundled plugin tier, which is why they cannot
 * live here — and then delegate to these. `apps/web` and `apps/setup-cli` resolve
 * against `coreSendProviderCatalogEntry` and call the same functions. One rule,
 * two lookups.
 *
 * AND EACH TAKES ONLY THE FIELD IT READS ({@link Declaring}), not a whole entry:
 * a caller that holds a PARTIAL declaration — `resolveReturnPathCapabilityForEntry`
 * in the backend folds two fields and a probe, and its fixtures declare those two
 * and nothing else — must be able to apply the rule rather than restate it as a
 * `?? 'no'` beside it. Demanding the entry shape is what made that restatement
 * the only option, and a rule with two expressions is the thing this module
 * exists to prevent.
 *
 * AN ABSENT ENTRY resolves to the same default as an absent field, for the same
 * reason: a kind the catalog does not declare has declared nothing, and crediting
 * it with a capability is exactly the failure the defaults exist to prevent. (The
 * backend's lookup throws on an unknown kind before it gets here, so that path is
 * unchanged.) That is what lets web pass a core-only lookup result straight in:
 * a bundled plugin kind it cannot see reads as "declares nothing", not as a crash.
 *
 * Split out of `./sendProviderCatalog` rather than declared beside the entries so
 * that the declaration and the reading of it are separable — and re-exported from
 * there, so every consumer still imports one module.
 */

import type {
	AcceptanceSemantics,
	DeclaredCustomReturnPathSupport,
	DomainVerificationSupport,
	MessageIdSource,
	SendProviderCatalogEntryShape,
} from './sendProviderCatalogTypes';

/**
 * A declaration carrying the field this accessor reads, or nothing at all — see
 * the module note. Either a whole entry (the ordinary call, unchanged) or the
 * PARTIAL declaration a fold holds, which is what keeps such a caller from
 * restating the default beside it.
 *
 * The entry shape is named in the union rather than left implied by the `Pick`,
 * because TypeScript's weak-type check rejects an object with no property in
 * common with a target whose properties are ALL optional — and an entry that
 * declares none of the capability fields (an undeclared plugin-tier fixture, the
 * exact input these defaults exist for) is precisely that object.
 */
type Declaring<Field extends keyof SendProviderCatalogEntryShape> =
	| SendProviderCatalogEntryShape
	| Pick<SendProviderCatalogEntryShape, Field>
	| undefined;

/** Declared envelope-sender control — see {@link DeclaredCustomReturnPathSupport}. */
export function supportsCustomReturnPathOf(
	entry: Declaring<'supportsCustomReturnPath'>
): DeclaredCustomReturnPathSupport {
	return entry?.supportsCustomReturnPath ?? 'no';
}

/** Declared sending-domain verification path — see {@link DomainVerificationSupport}. */
export function domainVerificationOf(
	entry: Declaring<'domainVerification'>
): DomainVerificationSupport {
	return entry?.domainVerification ?? 'none';
}

/** Does this transport report bounces/complaints back to us out of band? */
export function hasProviderFeedbackOf(entry: Declaring<'hasProviderFeedback'>): boolean {
	return entry?.hasProviderFeedback === true;
}

/** What a successful — and an ambiguous — dispatch means; see {@link AcceptanceSemantics}. */
export function acceptanceSemanticsOf(
	entry: Declaring<'acceptanceSemantics'>
): AcceptanceSemantics {
	return entry?.acceptanceSemantics ?? 'unknown-on-timeout';
}

/** Where the recorded provider message id comes from; see {@link MessageIdSource}. */
export function messageIdSourceOf(entry: Declaring<'messageIdSource'>): MessageIdSource {
	return entry?.messageIdSource ?? 'provider';
}

/** Does a repeat under the same idempotency key deliver once? Fail closed: no. */
export function deduplicatesOnIdempotencyKeyOf(
	entry: Declaring<'deduplicatesOnIdempotencyKey'>
): boolean {
	return entry?.deduplicatesOnIdempotencyKey === true;
}

/** Does this transport's inbound feedback carry our own provenance tag? */
export function tagsFeedbackProvenanceOf(entry: Declaring<'tagsFeedbackProvenance'>): boolean {
	return entry?.tagsFeedbackProvenance === true;
}
