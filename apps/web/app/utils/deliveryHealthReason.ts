/**
 * The delivery-health roll-up's reason, as words for the reader's language.
 *
 * `delivery.health.getDeliveryHealth` names its worst offender as a code from
 * `@owlat/api/deliveryHealthCopy`; this is the one place a code becomes a
 * catalog key, so the sidebar, the dashboard, the delivery hub and the audience
 * panel word it alike. Module scope, so no `useI18n` here: `useDeliveryHealth`
 * resolves the result.
 */
import { DELIVERY_HEALTH_REASON_KEYS, isDeliveryHealthReason } from '@owlat/api/deliveryHealthCopy';
import type { LocalizedText } from '~/utils/localizedText';

/**
 * The catalog key and params for a roll-up reason, or `null` for a code this
 * build does not know (a newer backend). A surface then shows its own generic
 * line rather than a raw code.
 */
export function deliveryHealthReasonText(
	reasonCode: unknown,
	reasonParams?: Readonly<Record<string, string>> | null
): LocalizedText | null {
	if (!isDeliveryHealthReason(reasonCode)) return null;
	return { key: DELIVERY_HEALTH_REASON_KEYS[reasonCode], params: { ...reasonParams } };
}
