import { api } from '@owlat/api';
import type { EmailBuilderBrand } from '@owlat/email-builder';
import { DEFAULT_BRAND_KIT_DESIGN, brandKitEmailTheme } from '@owlat/shared/brandKit';

/**
 * The organization's email theme and brand kit — the single source for every
 * editor and render surface, so they cannot drift. The theme is the brand
 * kit's projection (`brandKitEmailTheme`), the same one the server renders
 * stored emails with; before the kit loads, and on an instance that never
 * saved one, it is the shared defaults.
 *
 * `brand` is what the email builder takes as `config.brand`: brand swatches in
 * every colour picker, the logo and footer Blocks and "Apply brand kit".
 */
export function useEmailTheme() {
	const { data: brandKit } = useOrganizationQuery(api.workspaces.brandKit.get);
	const emailTheme = computed(() =>
		brandKitEmailTheme(brandKit.value?.design ?? DEFAULT_BRAND_KIT_DESIGN)
	);
	const brand = computed<EmailBuilderBrand | undefined>(() =>
		brandKit.value ? { design: brandKit.value.design, logos: brandKit.value.logos } : undefined
	);
	return { emailTheme, brand };
}
