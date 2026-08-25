/**
 * useChannelOutbound — the one manual send path for non-email channels.
 *
 * Two surfaces share it (the contact Unified Timeline composer and the Team
 * Inbox per-message reply), so everything that decides WHETHER a send happens
 * and WHAT the backend is asked to do lives here: the admin gate, the
 * configured-and-enabled filter, the chat-vs-provider branch with its differing
 * required target, and the outcome reporting. Its consumers mock it wholesale,
 * which makes this file the only place that behaviour is actually exercised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';

import { createTestI18n } from '~/__tests__/i18n';
import { useChannelOutbound, isProviderChannel } from '../useChannelOutbound';

// Called outside a component here, so `useI18n` is stubbed with the real
// catalog's `t` — the toast assertion below stays the English a sender reads.
const { t } = createTestI18n().global;

const SEND_CHANNEL = getFunctionName(api.channels.outbound.sendChannelMessage);
const SEND_CHAT = getFunctionName(api.unifiedMessages.sendChatMessage);

let role: 'owner' | 'admin' | 'editor' | null;
let channelConfigs: Array<{ channel: string; isEnabled: boolean }> | undefined;
/** What each backend operation resolves with — an `{ ok }` run envelope. */
let results: Record<string, unknown>;
let calls: Array<{ fn: string; args: unknown }>;
let toasts: Array<[string, string]>;
/** Per-operation loading flags, so `isSending` can be driven from either side. */
let loading: Record<string, ReturnType<typeof ref<boolean>>>;

beforeEach(() => {
	role = 'owner';
	channelConfigs = [
		{ channel: 'sms', isEnabled: true },
		{ channel: 'whatsapp', isEnabled: false },
		{ channel: 'generic', isEnabled: true },
		{ channel: 'email', isEnabled: true },
		{ channel: 'chat', isEnabled: true },
	];
	results = {
		[SEND_CHANNEL]: { ok: true, result: 'sent' },
		[SEND_CHAT]: { ok: true, result: 'msg_1' },
	};
	calls = [];
	toasts = [];
	loading = {};

	vi.stubGlobal('useOrganizationContext', () => ({ role: ref(role) }));
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(channelConfigs) }));
	vi.stubGlobal('useBackendOperation', (fnRef: Parameters<typeof getFunctionName>[0]) => {
		const fn = getFunctionName(fnRef);
		return {
			run: (args: unknown) => {
				calls.push({ fn, args });
				return Promise.resolve(results[fn]);
			},
			isLoading: (loading[fn] ??= ref(false)),
		};
	});
	vi.stubGlobal('useToast', () => ({
		showToast: (message: string, kind: string) => void toasts.push([message, kind]),
	}));
	vi.stubGlobal('useI18n', () => ({ t }));
});

describe('isProviderChannel', () => {
	it('separates the credentialed provider channels from the built-in ones', () => {
		expect(isProviderChannel('sms')).toBe(true);
		expect(isProviderChannel('whatsapp')).toBe(true);
		expect(isProviderChannel('generic')).toBe(true);
		expect(isProviderChannel('chat')).toBe(false);
		expect(isProviderChannel('email')).toBe(false);
	});
});

describe('useChannelOutbound gating', () => {
	it('offers nothing to a non-admin, not even chat', async () => {
		role = 'editor';
		const outbound = useChannelOutbound();

		expect(outbound.isAdmin.value).toBe(false);
		expect(outbound.canSendOn('sms')).toBe(false);
		expect(outbound.canSendOn('chat')).toBe(false);
		// And the gate is not merely cosmetic — nothing reaches the backend.
		expect(
			await outbound.send({ channel: 'chat', text: 'hi', threadId: 'thread_1' as never })
		).toBe(false);
		expect(calls).toEqual([]);
	});

	it('counts only the provider channels an admin has enabled', () => {
		const outbound = useChannelOutbound();
		// email/chat have no provider adapter; whatsapp is configured but off.
		expect(outbound.enabledProviderChannels.value).toEqual(['sms', 'generic']);
	});

	it('gates a provider channel on being configured AND enabled', () => {
		const outbound = useChannelOutbound();
		expect(outbound.canSendOn('sms')).toBe(true);
		expect(outbound.canSendOn('whatsapp')).toBe(false); // configured, disabled
		expect(outbound.canSendOn('email')).toBe(false); // owned by the mail pipeline
	});

	it('always offers chat to an admin — it has no credentials to configure', () => {
		channelConfigs = [];
		const outbound = useChannelOutbound();
		expect(outbound.canSendOn('chat')).toBe(true);
		expect(outbound.enabledProviderChannels.value).toEqual([]);
	});

	it('offers no provider channel while the config query is still loading', () => {
		channelConfigs = undefined;
		const outbound = useChannelOutbound();
		expect(outbound.enabledProviderChannels.value).toEqual([]);
		expect(outbound.canSendOn('sms')).toBe(false);
	});
});

describe('useChannelOutbound send guards', () => {
	it('sends nothing for blank or whitespace-only text', async () => {
		const outbound = useChannelOutbound();
		expect(
			await outbound.send({ channel: 'sms', text: '   ', contactId: 'contact_1' as never })
		).toBe(false);
		expect(calls).toEqual([]);
	});

	it('refuses a chat send with no thread to write into', async () => {
		const outbound = useChannelOutbound();
		expect(
			await outbound.send({ channel: 'chat', text: 'hi', contactId: 'contact_1' as never })
		).toBe(false);
		expect(calls).toEqual([]);
	});

	it('refuses a provider send with no contact to address', async () => {
		const outbound = useChannelOutbound();
		expect(await outbound.send({ channel: 'sms', text: 'hi', threadId: 'thread_1' as never })).toBe(
			false
		);
		expect(calls).toEqual([]);
	});

	it('refuses a send on a channel that is not enabled', async () => {
		const outbound = useChannelOutbound();
		expect(
			await outbound.send({ channel: 'whatsapp', text: 'hi', contactId: 'contact_1' as never })
		).toBe(false);
		expect(calls).toEqual([]);
	});
});

describe('useChannelOutbound dispatch', () => {
	it('routes chat straight to the Convex mutation, with the trimmed text', async () => {
		const outbound = useChannelOutbound();
		const sent = await outbound.send({
			channel: 'chat',
			text: '  hello there  ',
			threadId: 'thread_1' as never,
			contactId: 'contact_1' as never,
		});

		expect(sent).toBe(true);
		expect(calls).toEqual([
			{
				fn: SEND_CHAT,
				args: { threadId: 'thread_1', text: 'hello there', contactId: 'contact_1' },
			},
		]);
	});

	it('omits the optional contact on a chat send that has none', async () => {
		const outbound = useChannelOutbound();
		await outbound.send({ channel: 'chat', text: 'hi', threadId: 'thread_1' as never });
		expect(calls[0]!.args).toEqual({ threadId: 'thread_1', text: 'hi' });
	});

	it('routes a provider channel to the fail-safe action, pinned to the given thread', async () => {
		const outbound = useChannelOutbound();
		const sent = await outbound.send({
			channel: 'sms',
			text: 'on its way',
			contactId: 'contact_1' as never,
			threadId: 'thread_1' as never,
		});

		expect(sent).toBe(true);
		expect(calls).toEqual([
			{
				fn: SEND_CHANNEL,
				args: {
					contactId: 'contact_1',
					channel: 'sms',
					text: 'on its way',
					threadId: 'thread_1',
				},
			},
		]);
	});

	it('omits the thread on a provider send from the contact composer, so it is inferred', async () => {
		const outbound = useChannelOutbound();
		await outbound.send({ channel: 'generic', text: 'ping', contactId: 'contact_1' as never });
		expect(calls[0]!.args).toEqual({
			contactId: 'contact_1',
			channel: 'generic',
			text: 'ping',
		});
	});

	it('treats a null thread/contact the same as an absent one', async () => {
		const outbound = useChannelOutbound();
		await outbound.send({
			channel: 'sms',
			text: 'ping',
			contactId: 'contact_1' as never,
			threadId: null,
		});
		expect(calls[0]!.args).toEqual({ contactId: 'contact_1', channel: 'sms', text: 'ping' });
	});
});

describe('useChannelOutbound outcome', () => {
	it('confirms a successful send with a toast', async () => {
		const outbound = useChannelOutbound();
		await outbound.send({ channel: 'sms', text: 'hi', contactId: 'contact_1' as never });
		expect(toasts).toEqual([['Message sent', 'success']]);
	});

	it('reports itself sending while EITHER backend operation is in flight', () => {
		const outbound = useChannelOutbound();
		expect(outbound.isSending.value).toBe(false);

		loading[SEND_CHANNEL]!.value = true;
		expect(outbound.isSending.value).toBe(true);
		loading[SEND_CHANNEL]!.value = false;

		loading[SEND_CHAT]!.value = true;
		expect(outbound.isSending.value).toBe(true);
	});

	it('reports failure without a success toast, so the composer can keep the text', async () => {
		// `ok: false` is how useBackendOperation reports a handled failure (it has
		// already surfaced the error itself).
		results = { [SEND_CHANNEL]: { ok: false }, [SEND_CHAT]: { ok: false } };
		const outbound = useChannelOutbound();

		expect(
			await outbound.send({ channel: 'sms', text: 'hi', contactId: 'contact_1' as never })
		).toBe(false);
		expect(calls).toHaveLength(1); // it DID attempt the send
		expect(toasts).toEqual([]);
	});
});
