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

import type { FunctionArgs } from 'convex/server';
import type { api } from '@owlat/api';

/**
 * The unified-message channel discriminator — DERIVED, never restated.
 *
 * `unifiedMessageChannelValidator` (apps/api/convex/lib/convexValidators.ts) is
 * the single declaration; this reads it back off the mutation every channel
 * screen already calls. Adding a literal there therefore widens this type, and
 * every exhaustive `Record<ChannelKind, …>` in the channel UI (the config
 * form's credential-field and info-message tables) stops compiling until the
 * new kind is handled — instead of silently rendering a channel with no fields.
 */
export type ChannelKind = FunctionArgs<typeof api.unifiedMessages.updateChannelConfig>['channel'];

/**
 * A translatable value produced by a module-scope definition set: the message
 * KEY a rendering component resolves, plus the parameters it interpolates. The
 * tables below never call `useI18n` — they are evaluated once, at import time,
 * long before a locale is active.
 */
export type LocalizedText = string | { key: string; params?: Record<string, unknown> };

export interface AddableChannel {
	kind: ChannelKind;
	icon: string;
	/** i18n message key — the "Add channel" menu resolves it. */
	label: LocalizedText;
}

/**
 * External messaging channels an operator can add. Excludes the built-in
 * `email` and `chat` kinds. Mirrors the `unifiedMessageChannelValidator`
 * literal set (apps/api/convex/lib/convexValidators.ts) minus the built-ins.
 */
export const ADDABLE_CHANNEL_KINDS: AddableChannel[] = [
	{ kind: 'sms', icon: 'lucide:smartphone', label: 'shared.channelKinds.addable.sms' },
	{ kind: 'whatsapp', icon: 'lucide:message-circle', label: 'shared.channelKinds.addable.whatsapp' },
	{ kind: 'generic', icon: 'lucide:webhook', label: 'shared.channelKinds.addable.generic' },
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
	label: LocalizedText;
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
	if (status === 'down') {
		return { variant: 'error', dotClass: 'bg-error', label: 'shared.channelKinds.health.down' };
	}
	if (status === 'degraded') {
		return {
			variant: 'warning',
			dotClass: 'bg-warning',
			label: 'shared.channelKinds.health.degraded',
		};
	}
	return { variant: 'success', dotClass: 'bg-success', label: 'shared.channelKinds.health.healthy' };
}
