import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

// better-auth's store: listen() subscribes and calls back right away with the
// current value, like the nanostores atom it wraps.
const signalListeners: Array<() => void> = [];
vi.mock('~/lib/auth-client', () => ({
	authClient: {
		$store: {
			listen: (_signal: string, listener: () => void) => {
				signalListeners.push(listener);
				listener();
			},
		},
	},
}));

import { resolvePostboxMessageBody } from '../postboxBodyResolver';
import { postboxBodyScopeKey, usePostboxBodyCacheScope } from '../usePostboxBodyCacheScope';

function makeClient() {
	const action = vi.fn(async () => ({
		htmlInline: '<p>body</p>',
		textInline: null,
		htmlUrl: null,
		textUrl: null,
	}));
	return { client: { action }, action };
}

const user = ref<{ id: string } | null>({ id: 'user-1' });
const activeOrganizationId = ref<string | null>('org-1');

beforeEach(() => {
	signalListeners.length = 0;
	user.value = { id: 'user-1' };
	activeOrganizationId.value = 'org-1';
	vi.stubGlobal('useAuth', () => ({ user, activeOrganizationId }));
});

function setup(client: object, mailboxId = ref<string | null>('mailbox-a')) {
	vi.stubGlobal('useConvex', () => client);
	const scope = effectScope();
	scope.run(() => usePostboxBodyCacheScope(mailboxId));
	return { scope, mailboxId };
}

describe('postboxBodyScopeKey', () => {
	it('needs both a user and a mailbox', () => {
		expect(postboxBodyScopeKey(null, 'org', 'mbx')).toBeNull();
		expect(postboxBodyScopeKey('user', 'org', null)).toBeNull();
		expect(postboxBodyScopeKey('user', null, 'mbx')).toBe('user||mbx');
	});
});

describe('usePostboxBodyCacheScope', () => {
	it('keeps bodies across a remount of the same mailbox', async () => {
		const { client, action } = makeClient();
		const first = setup(client);
		await resolvePostboxMessageBody(client, 'm1');
		first.scope.stop();

		setup(client);
		await resolvePostboxMessageBody(client, 'm1');
		expect(action).toHaveBeenCalledTimes(1);
	});

	it('drops bodies on a mailbox switch but not while the next mailbox loads', async () => {
		const { client, action } = makeClient();
		const { mailboxId } = setup(client);
		await resolvePostboxMessageBody(client, 'm1');

		mailboxId.value = null;
		await nextTick();
		await resolvePostboxMessageBody(client, 'm1');
		expect(action).toHaveBeenCalledTimes(1);

		mailboxId.value = 'mailbox-b';
		await nextTick();
		await resolvePostboxMessageBody(client, 'm1');
		expect(action).toHaveBeenCalledTimes(2);
	});

	it('drops bodies when the organization changes or the user signs out', async () => {
		const { client, action } = makeClient();
		setup(client);
		await resolvePostboxMessageBody(client, 'm1');

		activeOrganizationId.value = 'org-2';
		await nextTick();
		await resolvePostboxMessageBody(client, 'm1');
		expect(action).toHaveBeenCalledTimes(2);

		user.value = null;
		await nextTick();
		await resolvePostboxMessageBody(client, 'm1');
		expect(action).toHaveBeenCalledTimes(3);
	});

	it('drops bodies on any session change, also after the Postbox unmounted', async () => {
		const { client, action } = makeClient();
		const { scope } = setup(client);
		setup(client);
		// One listener per client, and registering it cleared nothing.
		expect(signalListeners).toHaveLength(1);
		await resolvePostboxMessageBody(client, 'm1');
		scope.stop();

		await resolvePostboxMessageBody(client, 'm1');
		expect(action).toHaveBeenCalledTimes(1);

		signalListeners[0]?.();
		await resolvePostboxMessageBody(client, 'm1');
		expect(action).toHaveBeenCalledTimes(2);
	});
});
