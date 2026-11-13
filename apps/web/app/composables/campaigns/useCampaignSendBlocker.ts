import { computed, type Ref } from 'vue';
import { api } from '@owlat/api';
import { isValidEmail } from '@owlat/shared';
import {
	blockerFromRefusal,
	presendBlocker,
	type CampaignRefusal,
	type SendBlocker,
} from '~/lib/campaignRefusal';

/**
 * What stops this campaign from going out, for the campaign editor and the
 * wizard's review step: `presend` is what both can see before the click (no
 * delivery provider for campaign mail, an unregistered or unverified From
 * domain), `refusal` is the reason a send or schedule was just refused with.
 * Both carry the same catalog keys the pre-flight names, so the warning and
 * the refusal read alike.
 */
export function useCampaignSendBlocker(options: {
	fromEmail: () => string;
	sendRefusal: Ref<CampaignRefusal | null>;
}) {
	const { te } = useI18n();

	const { data: domainVerification } = useOrganizationQuery(
		api.domains.domains.getEmailDomainVerificationStatus,
		() => {
			const email = options.fromEmail().trim();
			if (!email || !isValidEmail(email)) return undefined;
			return { email };
		}
	);

	// The pre-flight's own delivery-provider check.
	const { data: deliveryConfigured } = useOrganizationQuery(
		api.campaigns.preflight.getCampaignDeliveryConfigured
	);

	const presend = computed<SendBlocker | null>(() =>
		presendBlocker({
			deliveryConfigured: deliveryConfigured.value,
			domain: domainVerification.value,
		})
	);

	const refusal = computed<SendBlocker | null>(() =>
		options.sendRefusal.value
			? blockerFromRefusal(options.sendRefusal.value, (key) => te(key))
			: null
	);

	return { presend, refusal };
}
