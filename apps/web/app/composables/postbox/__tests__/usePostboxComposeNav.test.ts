// @vitest-environment happy-dom
/**
 * usePostboxComposeNav: how every "open a composer" call reaches the compose
 * page. Each open is its own request (`?c=`); a saved draft travels in the URL,
 * and anything only in memory is parked under the request key, in session state
 * and in sessionStorage, so a reload before it is saved keeps it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { composePageKey, seedCarriesText, usePostboxComposeNav } from '../usePostboxComposeNav';

const navigate = vi.fn(async () => {});
let states: Record<string, unknown>;

beforeEach(() => {
	navigate.mockClear();
	states = {};
	window.sessionStorage.clear();
	vi.stubGlobal('navigateTo', navigate);
	vi.stubGlobal('useState', (key: string, init: () => unknown) => (states[key] ??= ref(init())));
});

const lastTarget = () =>
	navigate.mock.calls.at(-1)![0] as unknown as { path: string; query: Record<string, string> };

describe('usePostboxComposeNav', () => {
	it('opens a saved draft by its id, as its own request', async () => {
		await usePostboxComposeNav().open({ mailboxId: 'mbx-1' as never, draftId: 'draft-1' as never });
		const target = lastTarget();
		expect(target.path).toBe('/dashboard/compose');
		expect(target.query).toMatchObject({ mailbox: 'mbx-1', draft: 'draft-1' });
		expect(target.query['c']).toBeTruthy();
	});

	it('gives every open a new request key, so the page remounts', async () => {
		const nav = usePostboxComposeNav();
		await nav.open({ mailboxId: 'mbx-1' as never });
		const first = lastTarget().query['c'];
		await nav.open({ mailboxId: 'mbx-1' as never });
		expect(lastTarget().query['c']).not.toBe(first);
		expect(composePageKey(first)).not.toBe(composePageKey(lastTarget().query['c']));
	});

	it('parks a prefilled seed and hands it back to the page', async () => {
		const nav = usePostboxComposeNav();
		const spec = { mailboxId: 'mbx-1' as never, prefillTo: ['ada@example.com'] };
		await nav.open(spec);
		expect(nav.seedFor(lastTarget().query['c']!)).toEqual(spec);
	});

	it('keeps a parked seed across a reload, until the page forgets it', async () => {
		const spec = { mailboxId: 'mbx-1' as never, prefillSubject: 'Edited offline' };
		await usePostboxComposeNav().open(spec);
		const key = lastTarget().query['c']!;

		states = {}; // a reload drops session state; sessionStorage stays
		const afterReload = usePostboxComposeNav();
		expect(afterReload.seedFor(key)).toEqual(spec);

		afterReload.forget(key);
		expect(afterReload.seedFor(key)).toBeNull();
	});

	it('binds a request to its draft row, in place of its seed', async () => {
		const nav = usePostboxComposeNav();
		await nav.open({ mailboxId: 'mbx-1' as never, prefillSubject: 'Old' });
		const key = lastTarget().query['c']!;
		nav.bindDraft(key, 'mbx-1' as never, 'draft-1' as never);

		states = {};
		expect(usePostboxComposeNav().seedFor(key)).toEqual({
			mailboxId: 'mbx-1',
			draftId: 'draft-1',
		});
	});

	it('tells text from a bare pointer at a saved draft', () => {
		expect(seedCarriesText({ mailboxId: 'm' as never, draftId: 'd' as never })).toBe(false);
		expect(seedCarriesText({ mailboxId: 'm' as never })).toBe(true);
		expect(
			seedCarriesText({ mailboxId: 'm' as never, draftId: 'd' as never, prefillSubject: 'x' })
		).toBe(true);
	});
});
