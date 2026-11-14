import { api } from '@owlat/api';
import type { EmailBuilderBrand } from '@owlat/email-builder';
import {
	DEFAULT_BRAND_KIT_DESIGN,
	brandKitEmailTheme,
	senderPostalAddress,
} from '@owlat/shared/brandKit';

/**
 * The organization's email theme and brand kit — the single source for every
 * editor and render surface, so they cannot drift. The theme is the brand
 * kit's projection (`brandKitEmailTheme`), the same one the server renders
 * stored emails with; before the kit loads, and on an instance that never
 * saved one, it is the shared defaults.
 *
 * `brand` is what the email builder takes as `config.brand`: brand swatches in
 * every colour picker, the logo and footer Blocks and "Apply brand kit".
 *
 * `senderAddress` is the company name and postal address the send path puts
 * into the footer of every marketing email; `undefined` while the kit has no
 * address (or has not loaded).
 */
export function useEmailTheme() {
	const { data: brandKit } = useOrganizationQuery(api.workspaces.brandKit.get);
	const emailTheme = computed(() =>
		brandKitEmailTheme(brandKit.value?.design ?? DEFAULT_BRAND_KIT_DESIGN)
	);
	const brand = computed<EmailBuilderBrand | undefined>(() =>
		brandKit.value ? { design: brandKit.value.design, logos: brandKit.value.logos } : undefined
	);
	const senderAddress = computed(() => senderPostalAddress(brandKit.value?.design));
	return { emailTheme, brand, senderAddress };
}
