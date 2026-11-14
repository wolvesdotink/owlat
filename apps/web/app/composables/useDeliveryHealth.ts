import { api } from '@owlat/api';
import { healthDotClass, levelTone } from '~/utils/healthTone';
import { deliveryHealthReasonText } from '~/utils/deliveryHealthReason';
import { useLocalized } from '~/composables/useLocalized';

export type DeliveryHealthLevel = 'ok' | 'warn' | 'error';

/**
 * Live delivery-health roll-up for the sidebar **Delivery** status dot. One
 * cheap org-scoped subscription (worst-of reputation risk, domain verification,
 * and provider config) — no N+1. Returns the level + the reason in the
 * reader's language (the backend names it by code), plus the token class the
 * dot fills with. `reason` is empty until the roll-up answers, and for a code
 * this build cannot word, so each surface falls back to its own generic line.
 *
 * `level` is `null` until the roll-up answers. It used to default to `'ok'`,
 * which made every consumer claim "Healthy" before anything had been checked —
 * a flash of a positive verdict on every load, and a permanent one whenever the
 * query never resolves. A health verdict gets no optimistic default: callers
 * render a placeholder while it is null.
 */
export function useDeliveryHealth() {
	const { data } = useOrganizationQuery(api.delivery.health.getDeliveryHealth);

	const level = computed<DeliveryHealthLevel | null>(() => data.value?.level ?? null);
	const localized = useLocalized();
	const reason = computed(() =>
		localized(deliveryHealthReasonText(data.value?.reasonCode, data.value?.reasonParams))
	);

	// Only surface the dot when there's something to say — a healthy (or not yet
	// known) send path stays quiet (no green dot cluttering the nav).
	const isVisible = computed(() => level.value !== null && level.value !== 'ok');

	// Background-color token per level, via the shared health tone→class map so
	// the dot, the page verdict chip, and the domain table can't drift apart.
	// Terracotta is reserved for actions, so this uses semantic tokens instead.
	// No level yet → the map's neutral "no signal" fill.
	const dotClass = computed(() =>
		level.value ? healthDotClass[levelTone(level.value)] : healthDotClass.neutral
	);

	return { level, reason, isVisible, dotClass };
}
