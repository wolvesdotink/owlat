import { type DeliveryProviderKind, isDeliveryProviderKind } from '@owlat/shared';
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
 * Human name for each transport kind — what the operator picked, in their words.
 * Exported so the per-transport DNS guidance names each kind the same way.
 */
export const TRANSPORT_LABEL: Record<DeliveryProviderKind, string> = {
	mta: 'Owlat mail server',
	ses: 'Amazon SES',
	resend: 'Resend',
	smtp: 'SMTP relay',
};

/** One-line description of how each transport delivers mail. */
const TRANSPORT_DESCRIPTION: Record<DeliveryProviderKind, string> = {
	mta: 'Owlat’s built-in mail server sends your mail directly and manages IP warm-up.',
	ses: 'Mail goes out through your Amazon SES account.',
	resend: 'Mail goes out through your Resend account.',
	smtp: 'Mail is handed to your SMTP relay, which delivers it on your behalf.',
};

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
			? TRANSPORT_LABEL[kind]
			: kind
				? `Unrecognized transport (${kind})`
				: 'No transport selected';
	const description = known
		? TRANSPORT_DESCRIPTION[kind]
		: kind && summary.providerLabel
			? `Mail goes out through ${summary.providerLabel}. Check that transport’s authentication setup before sending.`
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
