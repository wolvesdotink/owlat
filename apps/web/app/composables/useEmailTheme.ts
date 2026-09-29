import { api } from '@owlat/api';
import { DEFAULT_EMAIL_THEME } from '@owlat/shared/emailDefaults';

/**
 * The organization's configured email theme, merged over the shared
 * `DEFAULT_EMAIL_THEME` (the defaults the renderer uses too) — the
 * single source for every editor/render surface so they can't drift. Notably it
 * carries `baseWidth`: all three editors previously rebuilt a 3-field theme that
 * dropped it, so the Settings → Email Theme width slider never affected any
 * rendered or sent email.
 */
export function useEmailTheme() {
	const { data: organizationSettings } = useOrganizationQuery(api.workspaces.settings.get);
	const emailTheme = computed(() => {
		const theme = organizationSettings.value?.emailTheme;
		return {
			primaryColor: theme?.primaryColor || DEFAULT_EMAIL_THEME.primaryColor,
			fontFamily: theme?.fontFamily || DEFAULT_EMAIL_THEME.fontFamily,
			backgroundColor: theme?.backgroundColor || DEFAULT_EMAIL_THEME.backgroundColor,
			...(theme?.baseWidth ? { baseWidth: theme.baseWidth } : {}),
		};
	});
	return { emailTheme, organizationSettings };
}
