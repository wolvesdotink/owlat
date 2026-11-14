/**
 * The delivery-health roll-up as the backend answers it, for the suites of the
 * surfaces that print its reason. Those suites run the real
 * `useDeliveryHealth` over a stubbed query, so the sentence they assert is the
 * one the reader's catalog words.
 */
import { getFunctionName, type FunctionReference } from 'convex/server';
import { ref } from 'vue';
import { api } from '@owlat/api';
import de from '~~/i18n/locales/de.json';
import { createTestI18n } from '~/__tests__/i18n';

/** No delivery provider: the roll-up a fresh instance answers with. */
export const NO_PROVIDER_HEALTH = { level: 'error', reasonCode: 'no_provider' } as const;

/** Its sentence in each catalog. */
export const NO_PROVIDER_EN = 'No delivery provider is configured';
export const NO_PROVIDER_DE = 'Es ist kein Zustellungsanbieter eingerichtet';

/** A test i18n instance reading the German catalog. */
export function germanTestI18n(): ReturnType<typeof createTestI18n> {
	const i18n = createTestI18n();
	i18n.global.setLocaleMessage('de', de);
	i18n.global.locale.value = 'de';
	return i18n;
}

/**
 * A `useOrganizationQuery` stub that answers the roll-up with `health` and
 * every other read with `other` (or nothing).
 */
export function healthQueryStub(
	health: unknown,
	other: (name: string) => unknown = () => undefined
) {
	const healthName = getFunctionName(api.delivery.health.getDeliveryHealth);
	return (query: FunctionReference<'query'>) => {
		const name = getFunctionName(query);
		return {
			data: ref(name === healthName ? health : other(name)),
			isLoading: ref(false),
			error: ref(null),
			refetch: () => undefined,
		};
	};
}
