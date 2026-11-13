import { ref } from 'vue';
import type { OperationError } from '@owlat/shared/operationError';
import { campaignRefusalOf, type CampaignRefusal } from '~/lib/campaignRefusal';
import { useCapacityRefusal } from './useCapacityRefusal';

/**
 * Claim every pre-flight refusal off a failed send or schedule, so the surface
 * that pressed the button renders it in place: a capacity refusal as the
 * multi-day schedule (`useCapacityRefusal`), any other reason as a note that
 * says what is wrong and links to where it is fixed.
 *
 * Shared by the campaign editor (`useCampaignActions`) and the wizard's review
 * step, so both read the same refusal the same way. Failures that are not a
 * pre-flight refusal are left on the default toast path.
 */
export function useCampaignSendRefusal() {
	const { capacitySchedule, claimCapacityRefusal, dismissCapacitySchedule } = useCapacityRefusal();
	const sendRefusal = ref<CampaignRefusal | null>(null);

	/** `useBackendOperation`'s `onError`: `true` claims the failure. */
	const claimSendRefusal = (error: OperationError): boolean => {
		if (claimCapacityRefusal(error)) return true;
		const refusal = campaignRefusalOf(error);
		if (!refusal) return false;
		sendRefusal.value = refusal;
		return true;
	};

	/** Clear both before the next attempt, so a stale refusal never sits beside a new one. */
	const dismissSendRefusal = () => {
		dismissCapacitySchedule();
		sendRefusal.value = null;
	};

	return {
		capacitySchedule,
		sendRefusal,
		claimSendRefusal,
		dismissCapacitySchedule,
		dismissSendRefusal,
	};
}
