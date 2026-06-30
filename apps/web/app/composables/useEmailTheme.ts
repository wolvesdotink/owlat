import { api } from '@owlat/api';

/**
 * The organization's configured email theme, merged over renderer defaults — the
 * single source for every editor/render surface so they can't drift. Notably it
 * carries `baseWidth`: all three editors previously rebuilt a 3-field theme that
 * dropped it, so the Settings → Email Theme width slider never affected any
 * rendered or sent email.
 */
export function useEmailTheme() {
	const { data: organizationSettings } = useOrganizationQuery(api.organizations.settings.get);
	const emailTheme = computed(() => {
		const theme = organizationSettings.value?.emailTheme;
		return {
			primaryColor: theme?.primaryColor || '#c4785a',
			fontFamily: theme?.fontFamily || 'Arial, sans-serif',
			backgroundColor: theme?.backgroundColor || '#ffffff',
			...(theme?.baseWidth ? { baseWidth: theme.baseWidth } : {}),
		};
	});
	return { emailTheme, organizationSettings };
}
