import type { DeliverabilityChecklistStatus, DeliverabilityCheckId } from '@owlat/shared';
import type { Doc, Id } from '../_generated/dataModel';
import type { SendingDomainProviderKind } from '../domains/providers/types';

/**
 * One relay proof row, tagged with the sending-domain provider kind whose
 * identity it is.
 *
 * The validator credits a proof only to the relay kind the row names. A
 * deployment that switches its fallback to another relay keeps its old rows
 * (nothing deletes them on a switch, and `verifyDomain` keeps refreshing them),
 * so crediting "every relay identity is proven" without asking whose rows they
 * are would report a relay that holds ZERO identities as ready.
 *
 * The tag is a sending-domain provider kind and the route names a send-transport
 * kind. They are compared as strings: every send kind that can prove a domain
 * has a domain provider of the same spelling
 * (`_ApiVerifiedKindsHaveDomainProviders`, `domains/providers/index.ts`).
 */
export type ChecklistRelayIdentity = Doc<'sendingDomainSesIdentities'> & {
	readonly providerKind: SendingDomainProviderKind;
};

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
	relayIdentities: ChecklistRelayIdentity[];
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
	 * REQUIRED, like every other field here, and for the reason they are: an
	 * empty array is a real answer ("nothing is ready", the fail-closed posture
	 * `isFallbackRelayEligible` takes about every input it cannot vouch for),
	 * but an OMISSION is not. Optional plus a `?? []` default would turn a
	 * future context assembler that forgot to project it into the entirely
	 * plausible-looking verdict "No verified relay fallback is configured"
	 * instead of a build failure, on the one item whose whole job is to tell an
	 * operator whether their fallback works.
	 */
	readyRelayKinds: readonly string[];
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
