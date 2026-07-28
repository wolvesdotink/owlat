import { ref } from 'vue';
import type { OperationError } from '@owlat/shared/operationError';
import {
	capacityRefusalPlan,
	type CampaignCapacitySchedulePlan,
} from '~/lib/campaignCapacityRefusal';

/**
 * Claim the campaign capacity refusal off a failed send/schedule operation and
 * hold the multi-day schedule it handed back.
 *
 * Pre-flight refuses a campaign that provably cannot finish inside the MTA's
 * message-retention horizon and attaches the schedule it WOULD take. That is
 * not a fault — it is an offer, and the deliverability plan (D14) is explicit
 * that a multi-day send is a normal, visible state for a warming deployment,
 * never an error and never a surprise. Claiming the failure here is what keeps
 * it off the generic red `invalid_state` toast.
 *
 * Lives in one place because BOTH send surfaces need it — the campaign editor
 * (`useCampaignActions`) and the wizard's Review step — and a second copy of
 * "which failures are really offers" is exactly the kind of drift that ends
 * with one surface showing a schedule and the other a red error for the same
 * refusal. It is also the only testable seam over that wiring.
 */
export function useCapacityRefusal() {
	const capacitySchedule = ref<CampaignCapacitySchedulePlan | null>(null);

	/**
	 * `useBackendOperation`'s `onError` contract: return `true` to claim the
	 * failure (this caller renders it), `false` to leave it on the default
	 * toast + telemetry path. Anything that is not a capacity refusal — or
	 * carries a schedule we cannot render — is deliberately NOT claimed.
	 */
	const claimCapacityRefusal = (error: OperationError): boolean => {
		const plan = capacityRefusalPlan(error);
		if (!plan) return false;
		capacitySchedule.value = plan;
		return true;
	};

	const dismissCapacitySchedule = () => {
		capacitySchedule.value = null;
	};

	return { capacitySchedule, claimCapacityRefusal, dismissCapacitySchedule };
}
