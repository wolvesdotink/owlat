/**
 * OSTR inbound signal — the wire contract for what the MTA stamps on a delivery.
 *
 * The Open Sender Trust Registry (plan §12.2, ADR-0058) is consulted on the MTA
 * side by `@owlat/ostr-client`; Convex only ever sees the RESULT of that lookup,
 * riding along on the `inbound.mailbox.received` webhook. This module is the one
 * place that shape is stated, so the four places that touch it — the webhook
 * boundary (`mail/webhook.ts`), the ingest action and delivery mutation
 * (`mail/delivery.ts`), and the persisted column (`schema/mail.ts`) — cannot
 * drift from each other or from the packages that produced the values.
 *
 * Nothing here talks to a registry, a log, or DNS. It re-states a contract and
 * narrows untrusted JSON; the scoring, attestation and observer machinery lives
 * in `@owlat/ostr-core` / `@owlat/ostr-observer` and is never reimplemented here.
 *
 * The two shapes below are DECLARED rather than imported from those packages,
 * for two reasons: a Convex argument needs a `v.*` validator, which a
 * dependency-free spec package cannot hand us; and Convex typechecks its
 * functions against its own runtime's `lib` (ES2021), under which the ostr-core
 * barrel does not compile — today it is a single `Object.hasOwn` (an ES2022
 * method) in `attestation/validate.ts`. So this is the seam.
 *
 * A declared copy can drift, so it is not left unguarded: `__tests__/tierPin`
 * reads ostr-core's own `Tier` union and fails if the two ever disagree. It
 * reads the SOURCE rather than importing it, for the lib reason above, and
 * that test is a stand-in for the type-level pin (`import type { Tier }` plus a
 * bidirectional `extends` assertion) that becomes possible the moment ostr-core
 * compiles under the Convex lib. Swap it then.
 *
 * `@owlat/ostr-core` and `@owlat/ostr-observer` are ordinary production
 * dependencies of this workspace: the observer modules (`ostr/observer.ts`,
 * `ostr/window.ts`) import them inside `'use node'` actions, and
 * `docker/convex-deploy.Dockerfile` copies both into the deploy image.
 *
 * The drift direction is deliberately fail-soft either way: a tier added to the
 * spec and not added here is DROPPED at the boundary and the message delivers as
 * if the registry had said nothing.
 */

import { v, type Infer } from 'convex/values';

/**
 * The five tiers of plan §6.1, in ascending order of evidence. `warned` and
 * `flagged` are the only negative ones, and only `flagged` means "strong,
 * multi-observer negative evidence" — which is why it is the only tier any
 * routing decision is allowed to read (see `isOstrFlaggedTier`).
 */
export const ostrTierValidator = v.union(
	v.literal('unknown'),
	v.literal('establishing'),
	v.literal('trusted'),
	v.literal('warned'),
	v.literal('flagged')
);
export type OstrTier = Infer<typeof ostrTierValidator>;

/**
 * The same five, as data — `@owlat/ostr-core`'s `Tier` union, restated. Exported
 * so `__tests__/tierPin` can compare it against ostr-core's own declaration in
 * both directions; the boundary itself goes through `isOstrTier`.
 */
export const OSTR_TIERS: readonly OstrTier[] = [
	'unknown',
	'establishing',
	'trusted',
	'warned',
	'flagged',
];

/** Narrows an untrusted webhook field to a tier. Anything else is not a tier. */
export function isOstrTier(value: unknown): value is OstrTier {
	return typeof value === 'string' && (OSTR_TIERS as readonly string[]).includes(value);
}

/**
 * Whether a tier routes a message anywhere. `flagged` alone does, and only ever
 * into Spam — the plan is explicit that a tier is a signal and never a hard gate
 * by default (§6.1, §12.2), so `warned` and everything below it must leave
 * delivery byte-identical to a message that carried no tier at all.
 */
export function isOstrFlaggedTier(tier: OstrTier | undefined): boolean {
	return tier === 'flagged';
}

/**
 * The DKIM evidence bundle input an observer-mode MTA captures when a signature
 * verified — `@owlat/ostr-observer`'s `EvidenceInput`, restated as a validator
 * because a Convex argument needs one. Present ONLY when the instance runs
 * observer mode AND a signature verified, so absence is the normal case.
 *
 * Accepted at the webhook boundary only while observer mode is ON. The bundle
 * carries raw signed headers (From, Subject, Message-ID) and the point-in-time
 * DNS key record, which is data we should accept only when something is about to
 * use it — so `mail/webhook.ts` drops the field where it arrives rather than
 * parsing it, and `mail/delivery.ts` re-checks before it writes. It captures at
 * verification time by necessity: `dnsKeyRecordTxt` and `verifiedAt` cannot be
 * reconstructed from the stored .eml once the sender rotates its key, so
 * evidence for mail delivered before observer mode was enabled is simply not
 * recoverable. That is the accepted cost of not storing it speculatively.
 *
 * `verificationVerdict` is a plain string here where the package has a union:
 * the wire contract says string, and the observer step narrows it with the
 * package's own `DkimVerificationVerdict` rather than this boundary guessing.
 */
export const ostrDkimEvidenceValidator = v.object({
	signingDomain: v.string(),
	selector: v.string(),
	algorithm: v.string(),
	keyBits: v.optional(v.number()),
	usesBodyLengthTag: v.boolean(),
	signedHeaderNames: v.array(v.string()),
	rawSignedHeaders: v.array(v.object({ name: v.string(), raw: v.string() })),
	dkimSignatureHeader: v.string(),
	dnsKeyRecordTxt: v.string(),
	verificationVerdict: v.string(),
	verifiedAt: v.string(),
	messageId: v.string(),
	bodyHash: v.string(),
});
export type OstrDkimEvidence = Infer<typeof ostrDkimEvidenceValidator>;

/**
 * Narrow an untrusted webhook field to an evidence bundle, or `undefined`.
 *
 * Shape only — admissibility (key strength, header coverage, `l=` tag, verdict)
 * is `@owlat/ostr-core`'s `checkDkimEvidenceAdmissibility`, applied by the
 * observer, and duplicating any part of it here would be a second opinion that
 * can disagree with the one that counts.
 *
 * The returned object is REBUILT field by field rather than passed through: a
 * Convex object validator rejects unknown fields, so forwarding the caller's own
 * object would turn one stray key on the wire into a failed delivery.
 */
export function parseOstrDkimEvidence(value: unknown): OstrDkimEvidence | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const candidate = value as Record<string, unknown>;
	const text = (key: string): string | undefined => {
		const field = candidate[key];
		return typeof field === 'string' ? field : undefined;
	};

	const signingDomain = text('signingDomain');
	const selector = text('selector');
	const algorithm = text('algorithm');
	const dkimSignatureHeader = text('dkimSignatureHeader');
	const dnsKeyRecordTxt = text('dnsKeyRecordTxt');
	const verificationVerdict = text('verificationVerdict');
	const verifiedAt = text('verifiedAt');
	const messageId = text('messageId');
	const bodyHash = text('bodyHash');
	if (
		signingDomain === undefined ||
		selector === undefined ||
		algorithm === undefined ||
		dkimSignatureHeader === undefined ||
		dnsKeyRecordTxt === undefined ||
		verificationVerdict === undefined ||
		verifiedAt === undefined ||
		messageId === undefined ||
		bodyHash === undefined
	) {
		return undefined;
	}

	const usesBodyLengthTag = candidate['usesBodyLengthTag'];
	if (typeof usesBodyLengthTag !== 'boolean') return undefined;

	const keyBits = candidate['keyBits'];
	if (keyBits !== undefined && typeof keyBits !== 'number') return undefined;

	const names = candidate['signedHeaderNames'];
	if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) return undefined;

	const headers = candidate['rawSignedHeaders'];
	if (!Array.isArray(headers) || !headers.every(isRawSignedHeader)) return undefined;

	return {
		signingDomain,
		selector,
		algorithm,
		keyBits,
		usesBodyLengthTag,
		signedHeaderNames: [...names],
		rawSignedHeaders: headers.map((header) => ({ name: header.name, raw: header.raw })),
		dkimSignatureHeader,
		dnsKeyRecordTxt,
		verificationVerdict,
		verifiedAt,
		messageId,
		bodyHash,
	};
}

function isRawSignedHeader(value: unknown): value is { name: string; raw: string } {
	if (typeof value !== 'object' || value === null) return false;
	const header = value as Record<string, unknown>;
	return typeof header['name'] === 'string' && typeof header['raw'] === 'string';
}
