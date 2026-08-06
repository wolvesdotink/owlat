import type { DeliverabilityChecklistStatus, DeliverabilityCheckId } from '@owlat/shared';
import type { Doc, Id } from '../_generated/dataModel';
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
 */
export const RELAY_IDENTITY_PROOF_KIND: SendingDomainProviderKind = 'ses';

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
