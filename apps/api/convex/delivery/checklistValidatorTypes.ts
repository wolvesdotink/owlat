import type { DeliverabilityChecklistStatus, DeliverabilityCheckId } from '@owlat/shared';
import type { Doc, Id } from '../_generated/dataModel';

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
