/**
 * Channel-kind metadata for the Messaging channels settings page
 * (settings/channels.vue).
 *
 * Email and team chat are BUILT IN: email sending is configured under Sending
 * Domains + the delivery provider, and chat is natively integrated — neither
 * takes per-channel credentials. They therefore never appear in the
 * "Add channel" menu, which is scoped to the external messaging channels that
 * DO need provider credentials (SMS, WhatsApp, generic webhook). Existing email
 * /chat config rows still render via the channel cards; this list only governs
 * what can be *added*.
 */

export type ChannelKind = 'email' | 'sms' | 'whatsapp' | 'generic' | 'chat';

export interface AddableChannel {
	kind: ChannelKind;
	icon: string;
	label: string;
}

/**
 * External messaging channels an operator can add. Excludes the built-in
 * `email` and `chat` kinds. Mirrors the `unifiedMessageChannelValidator`
 * literal set (apps/api/convex/lib/convexValidators.ts) minus the built-ins.
 */
export const ADDABLE_CHANNEL_KINDS: AddableChannel[] = [
	{ kind: 'sms', icon: 'lucide:smartphone', label: 'SMS' },
	{ kind: 'whatsapp', icon: 'lucide:message-circle', label: 'WhatsApp' },
	{ kind: 'generic', icon: 'lucide:webhook', label: 'Generic webhook' },
];

/**
 * The addable channels that are not already configured. `updateChannelConfig`
 * is an upsert keyed on channel, so re-adding an existing kind would be a silent
 * no-op — filter those out of the menu.
 */
export function availableChannelKinds(
	existingChannels: ReadonlyArray<{ channel: string }>,
	addable: AddableChannel[] = ADDABLE_CHANNEL_KINDS
): AddableChannel[] {
	const existing = new Set(existingChannels.map((c) => c.channel));
	return addable.filter((c) => !existing.has(c.kind));
}

/**
 * Channel health monitoring status, as stored on `channelConfigs.healthStatus`
 * (apps/api/convex/schema/messaging.ts). Absent means monitoring has not run
 * yet — treated as healthy.
 */
export type ChannelHealthStatus = 'healthy' | 'degraded' | 'down';

export interface ChannelHealthDot {
	/** Semantic status variant (mirrors the settings/channels.vue roll-up). */
	variant: 'success' | 'warning' | 'error';
	/** Design-token background class for the small status dot. */
	dotClass: string;
	/** Human label for the dot's `title`/aria (no enum strings in the UI). */
	label: string;
}

/**
 * Map a channel's health status to a single status dot for the activity-feed
 * channel filter pills: healthy = success, degraded = warning, down = error.
 * An absent status is treated as healthy — the backend only writes a status
 * once monitoring has run, and an enabled-but-unchecked channel is presumed
 * good. Uses the shared success/warning/error design tokens (no hardcoded
 * colors) so it renders correctly in both themes.
 */
export function channelHealthDot(status: ChannelHealthStatus | undefined | null): ChannelHealthDot {
	if (status === 'down') return { variant: 'error', dotClass: 'bg-error', label: 'Down' };
	if (status === 'degraded')
		return { variant: 'warning', dotClass: 'bg-warning', label: 'Degraded' };
	return { variant: 'success', dotClass: 'bg-success', label: 'Healthy' };
}
