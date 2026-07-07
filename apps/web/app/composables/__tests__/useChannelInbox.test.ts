import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { useChannelInbox } from '../useChannelInbox';

// useChannelInbox subscribes to the global cross-channel `listRecent` query.
// Stub useConvexQuery so we can assert which query it subscribes to and that the
// channel filter flows into the args factory (server-side filtering — the gap
// this view closes is that `listRecent` previously had no frontend consumer).

let lastQueryName: string | null;
let lastArgsFactory: (() => unknown) | null;
const dataRef = ref<unknown>(undefined);
// getChannelConfigs data (org query) — drives the per-channel health dots.
const channelConfigsRef = ref<unknown>(undefined);
// Records the last updateThreadStatus call so the resolve action can be asserted.
let lastStatusArgs: unknown;

beforeEach(() => {
	lastQueryName = null;
	lastArgsFactory = null;
	dataRef.value = undefined;
	channelConfigsRef.value = undefined;
	lastStatusArgs = undefined;

	vi.stubGlobal(
		'useConvexQuery',
		(query: Parameters<typeof getFunctionName>[0], argsFactory: () => unknown) => {
			lastQueryName = getFunctionName(query);
			lastArgsFactory = argsFactory;
			return { data: dataRef, isLoading: ref(false), error: ref(undefined) };
		}
	);
	// getChannelConfigs is subscribed via useOrganizationQuery, not useConvexQuery.
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: channelConfigsRef,
		isLoading: ref(false),
		error: ref(undefined),
	}));
	vi.stubGlobal('useBackendOperation', () => ({
		run: (args: unknown) => {
			lastStatusArgs = args;
			return Promise.resolve({ success: true });
		},
	}));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
});

describe('useChannelInbox', () => {
	it('subscribes to unifiedMessages.listRecent', () => {
		useChannelInbox();
		expect(lastQueryName).toBe(getFunctionName(api.unifiedMessages.listRecent));
	});

	it('requests all channels (no channel arg) by default, with the given limit', () => {
		useChannelInbox(25);
		expect(lastArgsFactory?.()).toEqual({ limit: 25 });
	});

	it('passes the selected channel server-side when the filter is set', () => {
		const inbox = useChannelInbox();
		inbox.channelFilter.value = 'sms';
		expect(lastArgsFactory?.()).toEqual({ channel: 'sms', limit: 50 });
	});

	it('drops back to no channel arg when the filter is cleared', () => {
		const inbox = useChannelInbox();
		inbox.channelFilter.value = 'whatsapp';
		expect(lastArgsFactory?.()).toEqual({ channel: 'whatsapp', limit: 50 });
		inbox.channelFilter.value = null;
		expect(lastArgsFactory?.()).toEqual({ limit: 50 });
	});

	it('exposes the timeline (empty array until data arrives) and channel display helpers', () => {
		const inbox = useChannelInbox();
		expect(inbox.timeline.value).toEqual([]);
		dataRef.value = [
			{ _id: 'm1', channel: 'email', direction: 'inbound', createdAt: 0, content: {} },
		];
		expect(inbox.timeline.value).toHaveLength(1);
		expect(inbox.channelLabel('email')).toBe('Email');
		expect(inbox.channelLabel('sms')).toBe('SMS');
		expect(inbox.directionLabel('inbound')).toBe('Received');
		expect(inbox.directionLabel('outbound')).toBe('Sent');
	});

	it('surfaces a health dot only for enabled channels that have a config row', () => {
		const inbox = useChannelInbox();
		channelConfigsRef.value = [
			{ channel: 'sms', isEnabled: true, healthStatus: 'degraded' },
			{ channel: 'whatsapp', isEnabled: true }, // no status → healthy
			{ channel: 'generic', isEnabled: false, healthStatus: 'down' }, // disabled → no dot
		];
		expect(inbox.channelHealth('sms')?.variant).toBe('warning');
		expect(inbox.channelHealth('whatsapp')?.variant).toBe('success');
		// Disabled row and channels with no config row get no dot.
		expect(inbox.channelHealth('generic')).toBeNull();
		expect(inbox.channelHealth('email')).toBeNull();
	});

	it('resolves a conversation via the shared updateThreadStatus lifecycle', async () => {
		const inbox = useChannelInbox();
		await inbox.resolveThread('thread_1' as never);
		expect(lastStatusArgs).toEqual({ threadId: 'thread_1', status: 'resolved' });
	});
});
