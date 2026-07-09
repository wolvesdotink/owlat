import { api } from '@owlat/api';
import { healthDotClass, levelTone } from '~/utils/healthTone';

export type DeliveryHealthLevel = 'ok' | 'warn' | 'error';

/**
 * Live delivery-health roll-up for the sidebar **Delivery** status dot. One
 * cheap org-scoped subscription (worst-of reputation risk, domain verification,
 * and provider config) — no N+1. Returns the level + a human reason for the
 * dot's tooltip, plus the token class the dot fills with.
 */
export function useDeliveryHealth() {
	const { data } = useOrganizationQuery(api.delivery.health.getDeliveryHealth);

	const level = computed<DeliveryHealthLevel>(() => data.value?.level ?? 'ok');
	const reason = computed(() => data.value?.reason ?? '');

	// Only surface the dot when there's something to say — a healthy send path
	// stays quiet (no green dot cluttering the nav).
	const isVisible = computed(() => level.value !== 'ok');

	// Background-color token per level, via the shared health tone→class map so
	// the dot, the page verdict chip, and the domain table can't drift apart.
	// Terracotta is reserved for actions, so this uses semantic tokens instead.
	const dotClass = computed(() => healthDotClass[levelTone(level.value)]);

	return { level, reason, isVisible, dotClass };
}
