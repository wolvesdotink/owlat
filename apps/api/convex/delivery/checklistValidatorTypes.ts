import type { DeliverabilityChecklistStatus, DeliverabilityCheckId } from '@owlat/shared';
import type { Doc, Id } from '../_generated/dataModel';
import type { SendProviderKind } from '../lib/sendProviders/types';
import type { SendingDomainProviderKind } from '../domains/providers/types';

/**
 * WHOSE relay proof `ChecklistVerificationContext.relayIdentities` carries.
 *
 * The context loader reads exactly one table — the frozen
 * `sendingDomainSesIdentities` sibling (`delivery/checklist.ts`'s
 * `loadRelayIdentities`) — so those rows prove one kind's identities and no
 * other's. This constant is the DECLARATION of that fact, sitting beside the
 * field whose type already commits to the table; it is not an identity check,
 * and the validator that reads it compares a configured relay kind against this
 * constant rather than against a literal, exactly as the own-arm sites do.
 *
 * It exists because the two halves of `deployment.relay` must move together: a
 * deployment that switches its fallback from SES to another relay keeps its old
 * SES sibling rows (nothing deletes them on a switch, and `verifyDomain` keeps
 * refreshing them), so crediting "every relay identity is proven" from those
 * rows would report a relay that holds ZERO identities as ready. When the
 * generic `sendingDomainRelayIdentities` read lands beside
 * `providerRoutes.listDeliverabilityRelayDomains` — the two carry different
 * per-kind identity shapes and have to change together, see the sending-domain
 * section of `docs/abstractions.md` — this constant is replaced by asking the
 * loaded rows which kind they belong to, and nothing else in the validator
 * changes.
 *
 * TWO NAMESPACES, ONE STRING, PINNED. The rows belong to a SENDING-DOMAIN
 * provider (they are that provider's identity table), and the validator
 * compares this constant to `deliverabilityFallback.relayProviderType`, which
 * is a SEND-TRANSPORT kind off the route row. Those are different unions that
 * happen to spell this provider the same way, exactly like the own-arm pair —
 * and that pair carries a build-time equality assertion
 * (`domains/providers/index.ts`) precisely because the assumption is otherwise
 * invisible. Without the twin assertions below, a deployment where the two
 * unions diverge would take `identitiesReady` to false for every proven SES
 * route and warn on `deployment.relay` forever, with no test failing. Declared
 * `as const` rather than annotated so the literal type survives to be asserted;
 * both assertions are paid at build time and cost nothing at runtime.
 *
 * NOT DEFINITIONAL, and it must not be allowlisted as such by the P0.5 ratchet:
 * it is a statement about WHICH TABLE the context loader reads, and it is
 * deleted by the generic `sendingDomainRelayIdentities` read (P1.2). It is
 * enumerated as such in the family list in the `OWN_ARM_TRANSPORT_KIND`
 * docblock (`lib/sendProviders/strategies/adaptive_mix/index.ts`), which is
 * where that ratchet seeds its allowlist from.
 */
export const RELAY_IDENTITY_PROOF_KIND = 'ses' as const;

/**
 * Generic CONSTRAINTS, not a conditional type: a conditional resolves to
 * `never` and compiles, which would make this pin silent. Argument 1 is "the
 * rows really are this sending-domain provider's identities"; argument 2 is
 * "and the route field the validator compares it to spells it the same".
 */
type AssertProofKindSpansBothNamespaces<
	_Identities extends SendingDomainProviderKind,
	_Route extends SendProviderKind,
> = true;
export type _RelayIdentityProofKindSpansBothNamespaces = AssertProofKindSpansBothNamespaces<
	typeof RELAY_IDENTITY_PROOF_KIND,
	typeof RELAY_IDENTITY_PROOF_KIND
>;

export type ChecklistObservation = {
	validator: string;
	status: DeliverabilityChecklistStatus;
	observedValues: string[];
	diagnostic: string;
};

export type ChecklistVerificationRequest = {
	organizationId: string;
	itemId: DeliverabilityCheckId;
	domainId?: Id<'domains'>;
	expectedGeneration?: number;
	source: 'interactive' | 'retry' | 'sweep';
};

export type ChecklistVerificationContext = {
	domain: Doc<'domains'> | null;
	settings: Doc<'instanceSettings'> | null;
	warming: Doc<'warmingState'> | null;
	routes: Doc<'providerRoutes'>[];
	relayIdentities: Doc<'sendingDomainSesIdentities'>[];
	tracking: Doc<'trackingDomains'>[];
	postmaster: Doc<'googlePostmasterStats'> | null;
	/**
	 * Which of the relay kinds named by `routes`' enabled deliverability
	 * fallbacks this deployment can ACTUALLY send through — credentials, flag
	 * and the mutable plugin capability grant, i.e. `isSendProviderReady`, the
	 * same authority `setRoute` and `resolveRoute` gate on.
	 *
	 * PROJECTED RATHER THAN RE-DERIVED because the validators run in the Node
	 * runtime with no `ctx`. Reading credentials there is possible (`env` is a
	 * process concern) but the grant is a DOCUMENT, so an env-only answer is the
	 * one thing the validator could compute alone — and it is wrong for exactly
	 * the tier where being wrong is expensive: a bundled plugin transport whose
	 * `send:transport` grant has been revoked still has its env vars, so
	 * `resolveRoute` stops using it as the fallback while an env-only checklist
	 * goes on reporting the fallback relay ready. Two rules, one question, and
	 * the operator is told the thing that will not work does.
	 *
	 * OPTIONAL, AND ABSENT MEANS NOTHING IS READY. A context assembled without
	 * this projection cannot credit any relay, so `deployment.relay` reports "No
	 * verified relay fallback is configured" rather than falling back to a
	 * weaker source it would then present as the same verdict. Same fail-closed
	 * posture `isFallbackRelayEligible` takes about every input it cannot vouch
	 * for.
	 */
	readyRelayKinds?: readonly string[];
};

export function checklistObservation(
	validator: string,
	status: DeliverabilityChecklistStatus,
	diagnostic: string,
	observedValues: string[] = []
): ChecklistObservation {
	return { validator, status, observedValues, diagnostic };
}

export function pendingDnsStatus(isFinalRetry: boolean): DeliverabilityChecklistStatus {
	return isFinalRetry ? 'fail' : 'pending-dns';
}
