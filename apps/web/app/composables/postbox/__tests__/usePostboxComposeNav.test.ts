/**
 * usePostboxComposeNav: how every "open a composer" call reaches the compose
 * page. A saved draft travels in the URL; anything only in memory is parked in
 * session state under a key the page reads back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { usePostboxComposeNav } from '../usePostboxComposeNav';

const navigate = vi.fn(async () => {});

beforeEach(() => {
	navigate.mockClear();
	const states: Record<string, unknown> = {};
	vi.stubGlobal('navigateTo', navigate);
	vi.stubGlobal('useState', (key: string, init: () => unknown) => (states[key] ??= ref(init())));
});

describe('usePostboxComposeNav', () => {
	it('opens a saved draft by its id, in the URL', async () => {
		await usePostboxComposeNav().open({ mailboxId: 'mbx-1' as never, draftId: 'draft-1' as never });
		expect(navigate).toHaveBeenCalledWith({
			path: '/dashboard/compose',
			query: { mailbox: 'mbx-1', draft: 'draft-1' },
		});
	});

	it('parks a prefilled seed and hands it back to the page', async () => {
		const nav = usePostboxComposeNav();
		const spec = { mailboxId: 'mbx-1' as never, prefillTo: ['ada@example.com'] };
		await nav.open(spec);

		const [[target]] = navigate.mock.calls as unknown as [[{ query: { seed: string } }]];
		expect(target).toMatchObject({ path: '/dashboard/compose' });
		expect(nav.seedFor(target.query.seed)).toEqual(spec);
	});

	it('has nothing for a key it never parked (a reload)', () => {
		expect(usePostboxComposeNav().seedFor('gone')).toBeNull();
	});
});
