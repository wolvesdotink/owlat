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

/** The entry a capability is read off, or nothing at all — see the module note. */
type EntryOrNothing = SendProviderCatalogEntryShape | undefined;

/** Declared envelope-sender control — see {@link DeclaredCustomReturnPathSupport}. */
export function supportsCustomReturnPathOf(entry: EntryOrNothing): DeclaredCustomReturnPathSupport {
	return entry?.supportsCustomReturnPath ?? 'no';
}

/** Declared sending-domain verification path — see {@link DomainVerificationSupport}. */
export function domainVerificationOf(entry: EntryOrNothing): DomainVerificationSupport {
	return entry?.domainVerification ?? 'none';
}

/** Does this transport report bounces/complaints back to us out of band? */
export function hasProviderFeedbackOf(entry: EntryOrNothing): boolean {
	return entry?.hasProviderFeedback === true;
}

/** What a successful — and an ambiguous — dispatch means; see {@link AcceptanceSemantics}. */
export function acceptanceSemanticsOf(entry: EntryOrNothing): AcceptanceSemantics {
	return entry?.acceptanceSemantics ?? 'unknown-on-timeout';
}

/** Where the recorded provider message id comes from; see {@link MessageIdSource}. */
export function messageIdSourceOf(entry: EntryOrNothing): MessageIdSource {
	return entry?.messageIdSource ?? 'provider';
}

/** Does a repeat under the same idempotency key deliver once? Fail closed: no. */
export function deduplicatesOnIdempotencyKeyOf(entry: EntryOrNothing): boolean {
	return entry?.deduplicatesOnIdempotencyKey === true;
}

/** Does this transport's inbound feedback carry our own provenance tag? */
export function tagsFeedbackProvenanceOf(entry: EntryOrNothing): boolean {
	return entry?.tagsFeedbackProvenance === true;
}
