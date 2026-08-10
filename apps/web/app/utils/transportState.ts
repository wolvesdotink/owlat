import { capitalize, type DeliveryProviderKind, isDeliveryProviderKind } from '@owlat/shared';
import { coreSendProviderCatalogEntry } from '@owlat/shared/sendProviderCatalog';
import { parsePluginNamespacedKind } from '@owlat/plugin-kit';
import type { HealthTone } from '~/utils/healthTone';

/**
 * Pure display derivation for the Delivery hub's single transport card.
 *
 * The card leads the delivery surface with ONE answer: which outbound transport
 * this instance sends through, whether it is ready, and how it has been
 * behaving. This module turns the non-secret `getTransportSummary` shape into
 * the human label + health tone the card renders, kept DOM- and DB-free so the
 * copy and tone logic are unit-testable without mounting anything.
 *
 * Terracotta (brand) is deliberately never a health tone here — health uses the
 * same success/warning/error/neutral vocabulary as the rest of the delivery
 * surface (see `healthTone.ts`).
 */

/** Rolling health snapshot for the active provider (from `providerHealth`). */
export interface TransportHealthInput {
	status: 'healthy' | 'degraded' | 'down';
	lastCheckedAt: number;
}

/** Non-secret transport summary — mirrors `api.delivery.status.getTransportSummary`. */
export interface TransportSummaryInput {
	provider: string | null;
	providerLabel: string | null;
	canSend: boolean;
	advancedRoutingActive: boolean;
	health: TransportHealthInput | null;
}

/**
 * THE DELIVERY HUB'S NAME for a transport kind — the catalog's label, unless
 * this surface has always worded it differently.
 *
 * OVERRIDES, NOT A TABLE OF KINDS (the seams plan's D1/A3). It used to be an
 * exhaustive `Record<DeliveryProviderKind, string>`, which meant two things: a
 * sixth kind declared in the catalog was a COMPILE ERROR in a file outside its
 * bundle — precisely what "adding a provider touches nothing else" forbids —
 * and the two rows below were a second declaration of a name the catalog
 * already carries.
 *
 * The two that remain are this surface's own wording, kept because P1.2 is a
 * rendering refactor and renaming a card on a live dashboard is a user-visible
 * change: the hub says "Owlat mail server" where the catalog says "Owlat MTA",
 * and it drops Mandrill's parenthetical. Whether to unify that copy is a
 * wording decision for the plan owner (recorded in
 * `scripts/provider-identity-allowlist.txt`), not something this piece decides
 * silently. `ses`, `resend` and `smtp` needed no row: they already agreed with
 * the catalog, and a new kind simply gets its label.
 */
const TRANSPORT_LABEL_OVERRIDE: Partial<Record<DeliveryProviderKind, string>> = {
	mta: 'Owlat mail server',
	mandrill: 'Mailchimp Transactional',
};

/**
 * The name to print for a declared transport kind. One declaration behind it —
 * the catalog — plus the overrides above.
 *
 * NOT called `transportLabel`: `~/utils/providerRouting` already exports that
 * name for the id-against-a-catalog lookup, both are auto-imported, and
 * whichever lost would be silently substituted for the other in every template.
 */
export function transportKindLabel(kind: string): string {
	const override = isDeliveryProviderKind(kind) ? TRANSPORT_LABEL_OVERRIDE[kind] : undefined;
	return override ?? coreSendProviderCatalogEntry(kind)?.label ?? kind;
}

/**
 * The operator's name for a stored transport id, wherever prose has to NAME the
 * second arm — "instead of Amazon SES", not "instead of ses".
 *
 * TWO SHAPES REACH THIS, because the reference transport is any configured
 * relay (`configuredRelayKinds`): one of the built-in kinds, or a plugin
 * transport id `plugin.<pack>.<id>`. A built-in kind is named from the map
 * above — the same one the transport card and the DNS guidance use. A plugin
 * transport is named from the LEAF of its id, the pack author's own word for
 * it, because the plugin catalog's display label is not carried by the ramp and
 * dashboard queries: the transport card, which does read the catalog, may
 * therefore word that one relay differently until the label is threaded
 * through. The leaf is the closest name this surface can give without inventing
 * one, and it beats printing the namespaced id in a sentence.
 *
 * ANYTHING ELSE FALLS BACK TO THE RAW VALUE ON PURPOSE. The reference transport
 * can be whatever `EMAIL_PROVIDER` was set to, so an id this build does not know
 * must still read as itself; printing nothing, or "Unknown", would leave the
 * sentence naming a relay the operator cannot identify.
 *
 * NOT `providerRouting.transportLabel`, which resolves the SAME id against a
 * catalog it was handed. Both are auto-imported, so they may not share a name:
 * whichever lost would be silently substituted for the other in every template.
 */
export function transportIdLabel(kind: string): string {
	if (isDeliveryProviderKind(kind)) return transportKindLabel(kind);
	const plugin = parsePluginNamespacedKind(kind);
	return plugin === undefined ? kind : capitalize(plugin.localId);
}

/**
 * One-line description of how each transport delivers mail — per-vendor PROSE,
 * which the catalog states it deliberately does not carry.
 *
 * Optional for the same reason the labels above are: a kind with no sentence of
 * its own gets {@link genericTransportDescription} rather than a blank card or a
 * build failure in a file its bundle has no business touching.
 */
const TRANSPORT_DESCRIPTION: Partial<Record<DeliveryProviderKind, string>> = {
	mta: 'Owlat’s built-in mail server sends your mail directly and manages IP warm-up.',
	ses: 'Mail goes out through your Amazon SES account.',
	resend: 'Mail goes out through your Resend account.',
	smtp: 'Mail is handed to your SMTP relay, which delivers it on your behalf.',
	mandrill:
		'Mail goes out through your Mailchimp Transactional (Mandrill) account, so you keep the reputation you arrived with.',
};

/**
 * What a transport with no sentence of its own says — the same sentence an
 * unrecognized-but-labelled transport already got, because it answers the same
 * question with the same confidence.
 */
function genericTransportDescription(label: string): string {
	return `Mail goes out through ${label}. Check that transport’s authentication setup before sending.`;
}

export type ConfiguredTone = 'success' | 'error';

export interface TransportDisplay {
	/** Human transport name, or a "nothing selected" label. */
	label: string;
	/** One-line plain-language description of how it sends. */
	description: string;
	/** Whether a usable transport is configured (`canSend`). */
	isConfigured: boolean;
	/** Tone + label for the configured chip. */
	configuredTone: ConfiguredTone;
	configuredLabel: string;
	/** Health chip tone + label (neutral before the first send). */
	healthTone: HealthTone;
	healthLabel: string;
}

/** Map a `providerHealth.status` to the shared health tone + human label. */
function healthDisplay(health: TransportHealthInput | null): {
	tone: HealthTone;
	label: string;
} {
	if (!health) return { tone: 'neutral', label: 'No sends yet' };
	switch (health.status) {
		case 'healthy':
			return { tone: 'success', label: 'Sending normally' };
		case 'degraded':
			return { tone: 'warning', label: 'Some sends are failing' };
		case 'down':
			return { tone: 'error', label: 'Sends are failing' };
	}
}

/**
 * Derive everything the transport card renders from the summary. When no known
 * provider is selected the card shows a "choose a transport" empty state via the
 * `isConfigured: false` / neutral-health path.
 */
export function deriveTransportDisplay(summary: TransportSummaryInput): TransportDisplay {
	const kind = summary.provider ?? undefined;
	const known = isDeliveryProviderKind(kind);

	const label = summary.providerLabel
		? summary.providerLabel
		: known
			? transportKindLabel(kind)
			: kind
				? `Unrecognized transport (${kind})`
				: 'No transport selected';
	const description = known
		? (TRANSPORT_DESCRIPTION[kind] ?? genericTransportDescription(transportKindLabel(kind)))
		: kind && summary.providerLabel
			? genericTransportDescription(summary.providerLabel)
			: kind
				? 'The EMAIL_PROVIDER value isn’t one Owlat can send through. Choose a supported transport.'
				: 'Pick how this instance sends mail to start delivering campaigns and replies.';

	const health = healthDisplay(summary.health);

	return {
		label,
		description,
		isConfigured: summary.canSend,
		configuredTone: summary.canSend ? 'success' : 'error',
		configuredLabel: summary.canSend ? 'Ready to send' : 'Not ready',
		healthTone: health.tone,
		healthLabel: health.label,
	};
}
