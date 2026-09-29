/**
 * The send-provider rows the architecture diagrams draw (`ArchSystem`,
 * `ArchEmail`, `EmailArchitecture`), read from the core send-provider catalog.
 *
 * The diagrams used to spell the provider list out by hand, three times, and
 * all three fell behind the catalog. Now the only thing kept here is what the
 * catalog cannot know: an icon per kind. A new catalog entry shows up in every
 * diagram with the generic mail icon until someone gives it a bespoke one.
 *
 * This lives in `app/utils/`, not next to the components: Nuxt scans every
 * `.ts` file under `components/` as a component, so a helper module there
 * would be registered as one.
 */

import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	isOwnSendProviderKind,
	type CoreSendProviderKind,
} from '@owlat/shared/sendProviderCatalog';

const MAIL_ICON =
	'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z';
const CLOUD_ICON =
	'M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z';
const SERVER_ICON =
	'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2';

/** SVG path data (24x24 viewBox, stroked) per provider kind. */
export const PROVIDER_ICONS: Record<string, string> = {
	mta: SERVER_ICON,
	ses: CLOUD_ICON,
	resend: MAIL_ICON,
};

/** The icon for `kind`, falling back to the generic mail icon. */
export function providerIcon(kind: string): string {
	return PROVIDER_ICONS[kind] ?? MAIL_ICON;
}

export interface DocsSendProviderRow {
	kind: CoreSendProviderKind;
	/** The catalog entry's `label`, e.g. `Amazon SES`. */
	name: string;
	icon: string;
}

export interface DocsSendProviders {
	/** Our own MTA: the entry with `tier: 'own'`. */
	own: DocsSendProviderRow;
	/** Every other core provider, in catalog order. */
	alternatives: DocsSendProviderRow[];
}

/** The diagrams' provider rows: our MTA plus every alternative, in catalog order. */
export function docsSendProviders(): DocsSendProviders {
	const rows = CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((entry): DocsSendProviderRow => ({
		kind: entry.kind,
		name: entry.label,
		icon: providerIcon(entry.kind),
	}));
	const own = rows.find((row) => isOwnSendProviderKind(row.kind));
	if (!own) throw new Error('The send-provider catalog declares no own-tier entry');
	return { own, alternatives: rows.filter((row) => row !== own) };
}

/** What the delivery pipeline does for every provider (`ArchEmail`, `EmailArchitecture`). */
export const DELIVERY_PIPELINE_FEATURES: ReadonlyArray<{ label: string; icon: string }> = [
	{
		label: 'DKIM signing',
		icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
	},
	{ label: 'MX delivery', icon: 'M12 19l9 2-9-18-9 18 9-2zm0 0v-8' },
	{
		label: 'IP warming',
		icon: 'M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z',
	},
	{ label: 'Rate limiting', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
	{
		label: 'Health-aware failover',
		icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
	},
];
