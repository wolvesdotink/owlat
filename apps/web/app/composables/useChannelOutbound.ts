import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * The one manual send path for non-email channels, shared by every surface that
 * offers it.
 *
 * Two of them exist: the contact's Unified Timeline composer (pick a channel,
 * type, send) and the Team Inbox thread view's per-message reply (channel and
 * conversation already known). They differ only in how the target is chosen, so
 * the gating (`organization:manage` + the channel being enabled), the backend
 * calls, the loading state and the toast live here rather than in two copies
 * that can drift.
 *
 * `sms`/`whatsapp`/`generic` go through `channels.outbound.sendChannelMessage`,
 * which resolves the thread and schedules the same fail-safe provider dispatch
 * the AI agent's replies use. Native `chat` has no provider or credentials and
 * writes straight into Convex via `unifiedMessages.sendChatMessage`, so it needs
 * a thread but no channel config. Both are admin-only; the backend re-checks.
 */

/** Channels dispatched through a provider adapter — the ones with credentials. */
export const PROVIDER_CHANNELS = ['sms', 'whatsapp', 'generic'] as const;
export type ProviderChannel = (typeof PROVIDER_CHANNELS)[number];
export type SendableChannel = ProviderChannel | 'chat';

export function isProviderChannel(channel: string): channel is ProviderChannel {
	return (PROVIDER_CHANNELS as readonly string[]).includes(channel);
}

/** Everything a manual send needs. `threadId` is required for `chat`. */
export interface ChannelSendTarget {
	channel: SendableChannel;
	text: string;
	contactId?: Id<'contacts'> | null;
	threadId?: Id<'conversationThreads'> | null;
}

export function useChannelOutbound() {
	const { t } = useI18n();
	const { role } = useOrganizationContext();
	const isAdmin = computed(() => role.value === 'owner' || role.value === 'admin');

	const { data: channelConfigs } = useConvexQuery(
		api.unifiedMessages.getChannelConfigs,
		() => ({})
	);

	/** Provider channels an admin has enabled — the only ones that can send. */
	const enabledProviderChannels = computed<ProviderChannel[]>(() =>
		(channelConfigs.value ?? [])
			.filter((c) => c.isEnabled && isProviderChannel(c.channel))
			.map((c) => c.channel as ProviderChannel)
	);

	const { showToast } = useToast();
	const { run: sendChannelMessage, isLoading: isSendingChannel } = useBackendOperation(
		api.channels.outbound.sendChannelMessage,
		{ label: () => t('shared.useChannelOutbound.sendChannelMessageOperation'), type: 'action' }
	);
	const { run: sendChatMessage, isLoading: isSendingChat } = useBackendOperation(
		api.unifiedMessages.sendChatMessage,
		{ label: () => t('shared.useChannelOutbound.sendChatMessageOperation'), type: 'mutation' }
	);

	const isSending = computed(() => isSendingChannel.value || isSendingChat.value);

	/**
	 * Can this surface offer a send on `channel`? Chat only needs a thread (the
	 * caller supplies it); a provider channel must be configured and enabled.
	 */
	function canSendOn(channel: string): boolean {
		if (!isAdmin.value) return false;
		if (channel === 'chat') return true;
		return isProviderChannel(channel) && enabledProviderChannels.value.includes(channel);
	}

	/**
	 * Send, surface the outcome, and report whether it went. Errors are already
	 * shown by `useBackendOperation`, so a `false` return only tells the caller
	 * to keep the composer open with its text intact.
	 */
	async function send(target: ChannelSendTarget): Promise<boolean> {
		const text = target.text.trim();
		if (!text || !canSendOn(target.channel)) return false;

		let result: BackendOperationResult<unknown>;
		if (target.channel === 'chat') {
			if (!target.threadId) return false;
			result = await sendChatMessage({
				threadId: target.threadId,
				text,
				...(target.contactId ? { contactId: target.contactId } : {}),
			});
		} else {
			if (!target.contactId) return false;
			result = await sendChannelMessage({
				contactId: target.contactId,
				channel: target.channel,
				text,
				...(target.threadId ? { threadId: target.threadId } : {}),
			});
		}
		if (!result.ok) return false; // useBackendOperation surfaced the error
		showToast(t('shared.useChannelOutbound.messageSent'), 'success');
		return true;
	}

	return {
		isAdmin,
		enabledProviderChannels,
		isSending,
		canSendOn,
		send,
	};
}
