/**
 * The app's create verbs — the ones the command palette used to fake.
 *
 * "Compose" navigating to the inbox list and "New contact" navigating to the
 * contacts list both LOOK like they work: the URL changes, a plausible page
 * appears, and nothing is created. That is exactly the regression a rendering
 * test would miss, so this suite asserts the effects instead: a composer lands
 * in the shared stack, addressed to a real mailbox, and the contacts page is
 * asked for its Add dialog by query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';

const MAILBOX_LIST = getFunctionName(api.mail.mailbox.identity.list);

let path: string;
let activeMailboxId: ReturnType<typeof ref<string | null>>;
let opened: Array<Record<string, unknown>>;
let navigations: unknown[];
let mailboxes: Array<{ _id: string }>;
let queries: string[];
/** When set, `requireConvex()` throws — the no-client path. */
let convexUnavailable: boolean;

beforeEach(() => {
	path = '/dashboard/campaigns';
	activeMailboxId = ref<string | null>(null);
	opened = [];
	navigations = [];
	mailboxes = [{ _id: 'mbx_1' }, { _id: 'mbx_2' }];
	queries = [];
	convexUnavailable = false;

	vi.stubGlobal('useRoute', () => ({
		get path() {
			return path;
		},
	}));
	vi.stubGlobal('usePostboxComposerStack', () => ({
		open: (spec: Record<string, unknown>) => {
			opened.push(spec);
			return 'cmp_test';
		},
	}));
	vi.stubGlobal('usePostboxActiveMailbox', () => ({
		activeMailboxId,
		setActiveMailboxId: (id: string) => {
			activeMailboxId.value = id;
		},
	}));
	vi.stubGlobal('navigateTo', (to: unknown) => {
		navigations.push(to);
		return Promise.resolve();
	});
	vi.stubGlobal('requireConvex', () => {
		if (convexUnavailable) throw new Error('no client');
		return {
			query: (fnRef: Parameters<typeof getFunctionName>[0]) => {
				queries.push(getFunctionName(fnRef));
				return Promise.resolve(mailboxes);
			},
		};
	});
});

async function quickCreate() {
	vi.resetModules();
	const { useQuickCreate } = await import('../useQuickCreate');
	return useQuickCreate();
}

describe('openCompose', () => {
	it('opens a composer on the active mailbox without leaving the Postbox', async () => {
		path = '/dashboard/postbox/inbox';
		activeMailboxId.value = 'mbx_2';

		await (await quickCreate()).openCompose();

		expect(opened).toEqual([{ mailboxId: 'mbx_2' }]);
		expect(navigations).toEqual([]);
		// The selection was already known, so no subscription-shaped read happened.
		expect(queries).toEqual([]);
	});

	it('goes to the Postbox first when composing from another surface', async () => {
		activeMailboxId.value = 'mbx_2';

		await (await quickCreate()).openCompose();

		expect(navigations).toEqual(['/dashboard/postbox/inbox']);
		expect(opened).toEqual([{ mailboxId: 'mbx_2' }]);
	});

	it('resolves and remembers a mailbox when none is selected yet', async () => {
		await (await quickCreate()).openCompose();

		expect(queries).toEqual([MAILBOX_LIST]);
		expect(activeMailboxId.value).toBe('mbx_1');
		expect(opened).toEqual([{ mailboxId: 'mbx_1' }]);
	});

	it('lands on the Postbox — and opens nothing — when there is no mailbox', async () => {
		mailboxes = [];

		await (await quickCreate()).openCompose();

		expect(navigations).toEqual(['/dashboard/postbox/inbox']);
		expect(opened).toEqual([]);
	});

	it('still lands on the Postbox when the client is unavailable', async () => {
		convexUnavailable = true;

		await (await quickCreate()).openCompose();

		expect(navigations).toEqual(['/dashboard/postbox/inbox']);
		expect(opened).toEqual([]);
	});
});

describe('openNewContact', () => {
	it('asks the contacts page for its Add dialog', async () => {
		await (await quickCreate()).openNewContact();

		expect(navigations).toEqual([
			{ path: '/dashboard/audience/contacts', query: { action: 'add' } },
		]);
	});
});
