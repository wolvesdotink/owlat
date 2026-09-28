import { describe, expect, it, vi } from 'vitest';
import { openAfterSave, openWithoutSaving } from '../openAfterSave';

const URL_ = '/dashboard/send/emails/email_1/edit';

/** A stand-in for the blank tab `window.open('', '_blank')` returns. */
function fakeTab() {
	return {
		opener: {} as unknown,
		location: { href: 'about:blank' },
		close: vi.fn(),
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe('openAfterSave — browser', () => {
	it('opens the blank tab inside the click, before the save resolves', async () => {
		const tab = fakeTab();
		const openWindow = vi.fn(() => tab as unknown as Window);
		const saved = deferred<boolean>();
		const navigate = vi.fn();

		const result = openAfterSave({
			url: URL_,
			save: () => saved.promise,
			isDesktop: false,
			navigate,
			openWindow,
		});

		// Still synchronous: the popup blocker sees the user gesture.
		expect(openWindow).toHaveBeenCalledWith('', '_blank');
		expect(tab.opener).toBeNull();
		expect(tab.location.href).toBe('about:blank');

		saved.resolve(true);
		await expect(result).resolves.toBe(true);
		expect(tab.location.href).toBe(URL_);
		expect(tab.close).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});

	it('closes the blank tab when the save fails', async () => {
		const tab = fakeTab();
		const navigate = vi.fn();

		const result = await openAfterSave({
			url: URL_,
			save: async () => false,
			isDesktop: false,
			navigate,
			openWindow: () => tab as unknown as Window,
		});

		expect(result).toBe(false);
		expect(tab.close).toHaveBeenCalledOnce();
		expect(tab.location.href).toBe('about:blank');
		expect(navigate).not.toHaveBeenCalled();
	});

	it('still reports the save when the popup was blocked', async () => {
		const save = vi.fn(async () => true);

		const result = await openAfterSave({
			url: URL_,
			save,
			isDesktop: false,
			navigate: vi.fn(),
			openWindow: () => null,
		});

		expect(result).toBe(true);
		expect(save).toHaveBeenCalledOnce();
	});
});

describe('openAfterSave — desktop', () => {
	it('saves, then navigates in the same window without opening a popup', async () => {
		const order: string[] = [];
		const openWindow = vi.fn(() => null);
		const navigate = vi.fn(async (url: string) => {
			order.push(`navigate ${url}`);
		});

		const result = await openAfterSave({
			url: URL_,
			save: async () => {
				order.push('save');
				return true;
			},
			isDesktop: true,
			navigate,
			openWindow,
		});

		expect(result).toBe(true);
		expect(openWindow).not.toHaveBeenCalled();
		expect(order).toEqual(['save', `navigate ${URL_}`]);
	});

	it('stays on the page when the save fails', async () => {
		const openWindow = vi.fn(() => null);
		const navigate = vi.fn();

		const result = await openAfterSave({
			url: URL_,
			save: async () => false,
			isDesktop: true,
			navigate,
			openWindow,
		});

		expect(result).toBe(false);
		expect(navigate).not.toHaveBeenCalled();
		expect(openWindow).not.toHaveBeenCalled();
	});
});

describe('openWithoutSaving', () => {
	it('opens a new tab in a browser and keeps the edits', async () => {
		const openWindow = vi.fn(() => null);
		const discard = vi.fn();
		const navigate = vi.fn();

		await openWithoutSaving({ url: URL_, isDesktop: false, discard, navigate, openWindow });

		expect(openWindow).toHaveBeenCalledWith(URL_, '_blank', 'noopener');
		expect(discard).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});

	it('drops the edits before navigating in place on desktop', async () => {
		const order: string[] = [];
		const openWindow = vi.fn(() => null);

		await openWithoutSaving({
			url: URL_,
			isDesktop: true,
			discard: () => order.push('discard'),
			navigate: (url: string) => order.push(`navigate ${url}`),
			openWindow,
		});

		expect(order).toEqual(['discard', `navigate ${URL_}`]);
		expect(openWindow).not.toHaveBeenCalled();
	});
});
