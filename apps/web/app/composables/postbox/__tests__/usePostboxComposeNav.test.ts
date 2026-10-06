// @vitest-environment happy-dom
/**
 * usePostboxComposeNav: every "open a composer" call becomes its own compose
 * request (`?c=`). The request record (nonce, seed, row, parked text, owning
 * mount) lives in session state and in this tab's sessionStorage, so a reload
 * keeps it; it expires after 14 days, and once a page instance claims it only
 * that instance may change or forget it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
	COMPOSE_REQUEST_TTL_MS,
	composePageKey,
	composeRandomId,
	seedCarriesText,
	usePostboxComposeNav,
	withoutCreationKeys,
	withoutSeedText,
	type ComposeSpec,
} from '../usePostboxComposeNav';

const navigate = vi.fn(async (_target: unknown) => {});
let states: Record<string, unknown>;

beforeEach(() => {
	navigate.mockClear();
	states = {};
	window.sessionStorage.clear();
	vi.stubGlobal('navigateTo', navigate);
	vi.stubGlobal('useState', (key: string, init: () => unknown) => (states[key] ??= ref(init())));
});

afterEach(() => {
	vi.useRealTimers();
});

const mbx = 'mbx-1' as never;
const lastTarget = () =>
	navigate.mock.calls.at(-1)![0] as { path: string; query: Record<string, string> };
/** A reload: session state is gone, sessionStorage stays. */
const reload = () => {
	states = {};
	return usePostboxComposeNav();
};
const stored = (key: string) => window.sessionStorage.getItem(`owlat:compose-request:${key}`);

describe('usePostboxComposeNav — create and open', () => {
	it('makes a request with a nonce and the whole spec as its seed', () => {
		const nav = usePostboxComposeNav();
		const spec: ComposeSpec = { mailboxId: mbx, prefillTo: ['ada@example.com'] };
		const key = nav.create(spec);
		const request = nav.read(key)!;
		expect(request).toMatchObject({ v: 1, mountId: null, mailboxId: 'mbx-1', sources: [] });
		expect(request.requestNonce).toMatch(/^[0-9a-f]{24}$/);
		expect(request.requestNonce).not.toBe(key);
		expect(request.seed).toEqual(spec);
		expect(request.draftId).toBeUndefined();
		// Nothing navigates on a plain create.
		expect(navigate).not.toHaveBeenCalled();
	});

	it('opens a new message with only `c` in the URL', async () => {
		const nav = usePostboxComposeNav();
		await nav.open({ mailboxId: mbx, prefillSubject: 'Hi' });
		const target = lastTarget();
		expect(target.path).toBe('/dashboard/compose');
		expect(Object.keys(target.query)).toEqual(['c']);
		expect(nav.read(target.query['c']!)?.seed).toEqual({
			mailboxId: 'mbx-1',
			prefillSubject: 'Hi',
		});
	});

	it('opens a saved draft with no seed, naming the draft in the URL', async () => {
		const nav = usePostboxComposeNav();
		await nav.open({ mailboxId: mbx, draftId: 'draft-1' as never });
		const target = lastTarget();
		expect(target.query).toEqual({ c: expect.any(String), mailbox: 'mbx-1', draft: 'draft-1' });
		const request = nav.read(target.query['c']!)!;
		expect(request.draftId).toBe('draft-1');
		expect(request.seed).toBeUndefined();
	});

	it('keeps the seed of a draft opened with text (an offline undo)', async () => {
		const nav = usePostboxComposeNav();
		const spec: ComposeSpec = {
			mailboxId: mbx,
			draftId: 'draft-7' as never,
			prefillSubject: 'Edited offline',
		};
		await nav.open(spec);
		const target = lastTarget();
		expect(target.query).toMatchObject({ mailbox: 'mbx-1', draft: 'draft-7' });
		const request = nav.read(target.query['c']!)!;
		expect(request.draftId).toBe('draft-7');
		expect(request.seed).toEqual(spec);
	});

	it('gives every open a new request key and nonce, so the page remounts', async () => {
		const nav = usePostboxComposeNav();
		await nav.open({ mailboxId: mbx });
		const first = lastTarget().query['c']!;
		await nav.open({ mailboxId: mbx });
		const second = lastTarget().query['c']!;
		expect(second).not.toBe(first);
		expect(composePageKey(first)).not.toBe(composePageKey(second));
		expect(nav.read(first)!.requestNonce).not.toBe(nav.read(second)!.requestNonce);
	});
});

describe('usePostboxComposeNav — a reload', () => {
	it('reads the request back from sessionStorage', () => {
		const key = usePostboxComposeNav().create({ mailboxId: mbx, prefillSubject: 'Typed' });
		const before = usePostboxComposeNav().read(key)!;
		const after = reload().read(key);
		expect(after).toEqual(before);
	});

	it('keeps a claim and an update across it', () => {
		const nav = usePostboxComposeNav();
		const key = nav.create({ mailboxId: mbx });
		const mountId = nav.claim(key)!;
		nav.update(key, mountId, (request) => ({ ...request, draftId: 'draft-2' as never }));
		const after = reload();
		expect(after.read(key)).toMatchObject({ mountId, draftId: 'draft-2' });
		// The mount that wrote it still owns it after the reload.
		expect(after.update(key, mountId, () => null)).toBe(true);
	});

	it('ignores a malformed or foreign stored value', () => {
		window.sessionStorage.setItem('owlat:compose-request:bad-json', '{nope');
		window.sessionStorage.setItem('owlat:compose-request:old', JSON.stringify({ v: 0 }));
		const nav = usePostboxComposeNav();
		expect(nav.read('bad-json')).toBeNull();
		expect(nav.read('old')).toBeNull();
		expect(nav.read('never-made')).toBeNull();
	});

	it('still works in memory when sessionStorage refuses the write', () => {
		const real = window.sessionStorage;
		const refusing = {
			getItem: (key: string) => real.getItem(key),
			removeItem: (key: string) => real.removeItem(key),
			key: (index: number) => real.key(index),
			get length() {
				return real.length;
			},
			setItem: () => {
				throw new DOMException('full', 'QuotaExceededError');
			},
		} as unknown as Storage;
		const setItem = vi.spyOn(window, 'sessionStorage', 'get').mockReturnValue(refusing);
		try {
			const nav = usePostboxComposeNav();
			const key = nav.create({ mailboxId: mbx, prefillSubject: 'x' });
			expect(nav.read(key)?.seed?.prefillSubject).toBe('x');
			expect(reload().read(key)).toBeNull();
		} finally {
			setItem.mockRestore();
		}
	});
});

describe('usePostboxComposeNav — expiry', () => {
	it('keeps a request for 14 days and forgets it after', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-01T09:00:00Z'));
		const nav = usePostboxComposeNav();
		const key = nav.create({ mailboxId: mbx });

		vi.setSystemTime(Date.now() + COMPOSE_REQUEST_TTL_MS);
		expect(reload().read(key)).not.toBeNull();

		vi.setSystemTime(Date.now() + 1);
		const later = reload();
		expect(later.read(key)).toBeNull();
		// Expired is gone from storage too, and cannot be claimed.
		expect(stored(key)).toBeNull();
		expect(later.claim(key)).toBeNull();
	});

	it('expires from creation, not from the last write', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-01T09:00:00Z'));
		const nav = usePostboxComposeNav();
		const key = nav.create({ mailboxId: mbx });
		vi.setSystemTime(Date.now() + COMPOSE_REQUEST_TTL_MS - 1000);
		const mountId = nav.claim(key)!;
		vi.setSystemTime(Date.now() + 2000);
		expect(nav.read(key)).toBeNull();
		expect(nav.update(key, mountId, () => null)).toBe(false);
	});

	it('prunes other expired requests from storage on the next create', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-01T09:00:00Z'));
		const old = usePostboxComposeNav().create({ mailboxId: mbx });
		window.sessionStorage.setItem('unrelated', 'kept');
		vi.setSystemTime(Date.now() + COMPOSE_REQUEST_TTL_MS + 1);
		const fresh = reload().create({ mailboxId: mbx });
		expect(stored(old)).toBeNull();
		expect(stored(fresh)).not.toBeNull();
		expect(window.sessionStorage.getItem('unrelated')).toBe('kept');
	});
});

describe('usePostboxComposeNav — claim fencing', () => {
	it('hands the request to the newest claim; a stale mount can neither update nor forget', () => {
		const nav = usePostboxComposeNav();
		const key = nav.create({ mailboxId: mbx, prefillSubject: 'x' });
		const first = nav.claim(key)!;
		const second = nav.claim(key)!;
		expect(first).not.toBe(second);
		expect(nav.read(key)!.mountId).toBe(second);

		const staleChange = vi.fn((request) => ({ ...request, draftId: 'stale' as never }));
		expect(nav.update(key, first, staleChange)).toBe(false);
		expect(staleChange).not.toHaveBeenCalled();
		expect(nav.read(key)!.draftId).toBeUndefined();

		nav.forget(key, first);
		expect(nav.read(key)).not.toBeNull();

		expect(
			nav.update(key, second, (request) => ({ ...request, draftId: 'draft-1' as never }))
		).toBe(true);
		expect(nav.read(key)!.draftId).toBe('draft-1');
		nav.forget(key, second);
		expect(nav.read(key)).toBeNull();
		expect(stored(key)).toBeNull();
	});

	it('leaves the record alone when the change returns null', () => {
		const nav = usePostboxComposeNav();
		const key = nav.create({ mailboxId: mbx });
		const mountId = nav.claim(key)!;
		const before = nav.read(key);
		expect(nav.update(key, mountId, () => null)).toBe(true);
		expect(nav.read(key)).toEqual(before);
	});

	it('refuses an update before any claim and a claim of an unknown key', () => {
		const nav = usePostboxComposeNav();
		const key = nav.create({ mailboxId: mbx });
		expect(nav.update(key, 'anyone', () => null)).toBe(false);
		expect(nav.claim('missing')).toBeNull();
	});
});

describe('usePostboxComposeNav — adoptDraft', () => {
	it('makes a draft-only request under a key this tab never saw', () => {
		const nav = usePostboxComposeNav();
		nav.adoptDraft('copied-link', mbx, 'draft-3' as never);
		const request = nav.read('copied-link')!;
		expect(request).toMatchObject({
			v: 1,
			mountId: null,
			mailboxId: 'mbx-1',
			draftId: 'draft-3',
			sources: [],
		});
		expect(request.seed).toBeUndefined();
		expect(request.requestNonce).toMatch(/^[0-9a-f]{24}$/);
		expect(reload().read('copied-link')).toEqual(request);
	});
});

describe('usePostboxComposeNav — helpers', () => {
	it('keys the page on the request key only', () => {
		expect(composePageKey('abc')).toBe('compose:abc');
		expect(composePageKey(['abc', 'def'])).toBe('compose:abc');
		expect(composePageKey(undefined)).toBe('compose:');
		expect(composePageKey(42)).toBe('compose:');
	});

	it('makes colon-free random ids', () => {
		const ids = new Set(Array.from({ length: 50 }, () => composeRandomId()));
		expect(ids.size).toBe(50);
		for (const id of ids) expect(id).toMatch(/^[0-9a-f]{24}$/);
	});

	it('tells a seed with text from one that only names its target', () => {
		expect(seedCarriesText(undefined)).toBe(false);
		expect(seedCarriesText({ mailboxId: mbx })).toBe(false);
		expect(seedCarriesText({ mailboxId: mbx, draftId: 'd' as never })).toBe(false);
		expect(seedCarriesText({ mailboxId: mbx, inReplyToMessageId: 'm' as never })).toBe(false);
		expect(seedCarriesText({ mailboxId: mbx, prefillSubject: '' })).toBe(true);
		expect(seedCarriesText({ mailboxId: mbx, prefillBodyBlocks: [] })).toBe(true);
		expect(seedCarriesText({ mailboxId: mbx, prefillFollowUpRemindAt: null })).toBe(true);
		expect(seedCarriesText({ mailboxId: mbx, prefillComposerMode: 'full' })).toBe(true);
	});

	it('strips only the text keys, keeping the target and creation work', () => {
		const seed: ComposeSpec = {
			mailboxId: mbx,
			draftId: 'd' as never,
			requestNonce: 'n',
			inReplyToMessageId: 'm' as never,
			forwardAttachmentsFromMessageId: 'f' as never,
			prefillTo: ['a@example.com'],
			prefillCc: [],
			prefillBcc: [],
			prefillSubject: 's',
			prefillBodyHtml: '<p>b</p>',
			prefillBodyBlocks: [],
			prefillComposerMode: 'full',
			prefillFollowUpRemindAt: 1,
		};
		expect(withoutSeedText(seed)).toEqual({
			mailboxId: mbx,
			draftId: 'd',
			requestNonce: 'n',
			inReplyToMessageId: 'm',
			forwardAttachmentsFromMessageId: 'f',
		});
		expect(seedCarriesText(withoutSeedText(seed))).toBe(false);
		expect(withoutSeedText(undefined)).toBeUndefined();
		// Never mutates its input.
		expect(seed.prefillSubject).toBe('s');
	});

	it('strips only the creation-time keys', () => {
		const seed: ComposeSpec = {
			mailboxId: mbx,
			prefillSubject: 'Fwd',
			forwardAttachmentsFromMessageId: 'f' as never,
			attachGenerated: { filename: 'reply.ics', contentType: 'text/calendar', content: 'ics' },
		};
		expect(withoutCreationKeys(seed)).toEqual({ mailboxId: mbx, prefillSubject: 'Fwd' });
		expect(withoutCreationKeys(undefined)).toBeUndefined();
		expect(seed.attachGenerated?.content).toBe('ics');
	});
});
