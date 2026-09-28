import type { Variable } from '@owlat/email-builder';
import { api } from '@owlat/api';

/**
 * Contact property keys already covered by a built-in variable: the stored
 * `first_name` / `last_name` properties surface as `firstName` / `lastName`.
 */
const BUILT_IN_PROPERTY_KEYS = new Set(['first_name', 'last_name']);

/**
 * The personalization variables an email or saved-block editor offers: the
 * built-in email, first name and last name, then the organization's custom
 * contact properties.
 */
export function usePersonalizationVariables() {
	const { t } = useI18n();
	const { data: contactProperties } = useOrganizationQuery(
		api.contacts.properties.listByOrganization
	);

	return computed<Variable[]>(() => {
		const builtIn: Variable[] = [
			{ key: 'email', label: t('shared.personalizationVariables.email'), isBuiltIn: true },
			{ key: 'firstName', label: t('shared.personalizationVariables.firstName'), isBuiltIn: true },
			{ key: 'lastName', label: t('shared.personalizationVariables.lastName'), isBuiltIn: true },
		];
		const custom: Variable[] = (contactProperties.value || [])
			.filter((prop) => !BUILT_IN_PROPERTY_KEYS.has(prop.key))
			.map((prop) => ({ key: prop.key, label: prop.label, isBuiltIn: false }));
		return [...builtIn, ...custom];
	});
}
