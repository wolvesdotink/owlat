/**
 * Reveal-and-flash for settings deep links.
 *
 * The target of a Workspace deep link usually renders after the page's own
 * query answers, so the reveal has to wait for it, and must stop waiting when
 * it never comes or when the person has moved on. The outline is an attribute
 * on the element itself and expires on its own. Timers are fake throughout.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SETTINGS_FLASH_ATTRIBUTE, revealSettingsAnchor } from '../settingsAnchorReveal';

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
let scrolled: { id: string; options: ScrollIntoViewOptions | boolean | undefined }[];

function addTarget(id: string): HTMLElement {
	const el = document.createElement('section');
	el.id = id;
	document.body.append(el);
	onTestFinished(() => el.remove());
	return el;
}

beforeEach(() => {
	vi.useFakeTimers();
	scrolled = [];
	HTMLElement.prototype.scrollIntoView = function (options) {
		scrolled.push({ id: this.id, options });
	};
});

afterEach(() => {
	vi.useRealTimers();
	HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

/** MutationObserver callbacks are microtasks. */
const flushObservers = () => Promise.resolve();

describe('revealSettingsAnchor', () => {
	it('scrolls to and flashes a target that is already there, then clears the flash', () => {
		const target = addTarget('brand-colors');
		revealSettingsAnchor(document, 'brand-colors');

		expect(scrolled).toEqual([
			{ id: 'brand-colors', options: { behavior: 'smooth', block: 'start' } },
		]);
		expect(target.hasAttribute(SETTINGS_FLASH_ATTRIBUTE)).toBe(true);

		vi.advanceTimersByTime(1_999);
		expect(target.hasAttribute(SETTINGS_FLASH_ATTRIBUTE)).toBe(true);
		vi.advanceTimersByTime(1);
		expect(target.hasAttribute(SETTINGS_FLASH_ATTRIBUTE)).toBe(false);
	});

	it('jumps without smooth scrolling under reduced motion', () => {
		addTarget('ramp-presets');
		revealSettingsAnchor(document, 'ramp-presets', { reducedMotion: true });
		expect(scrolled[0]?.options).toEqual({ behavior: 'auto', block: 'start' });
	});

	it('waits for a target that renders once the page has loaded', async () => {
		revealSettingsAnchor(document, 'sending-domain-list');
		expect(scrolled).toEqual([]);

		const unrelated = document.createElement('div');
		document.body.append(unrelated);
		onTestFinished(() => unrelated.remove());
		await flushObservers();
		expect(scrolled).toEqual([]);

		const target = addTarget('sending-domain-list');
		await flushObservers();
		expect(scrolled.map((entry) => entry.id)).toEqual(['sending-domain-list']);
		expect(target.hasAttribute(SETTINGS_FLASH_ATTRIBUTE)).toBe(true);
	});

	it('picks up a target whose id is set after it was inserted', async () => {
		const el = document.createElement('div');
		document.body.append(el);
		onTestFinished(() => el.remove());
		revealSettingsAnchor(document, 'webhook-signing');
		el.id = 'webhook-signing';
		await flushObservers();
		expect(scrolled.map((entry) => entry.id)).toEqual(['webhook-signing']);
	});

	it('gives up on a target that never arrives', async () => {
		revealSettingsAnchor(document, 'ai-reply-mode');
		vi.advanceTimersByTime(10_000);
		addTarget('ai-reply-mode');
		await flushObservers();
		expect(scrolled).toEqual([]);
	});

	it('stops waiting and clears the flash when cancelled', async () => {
		const cancelWaiting = revealSettingsAnchor(document, 'late');
		cancelWaiting();
		addTarget('late');
		await flushObservers();
		expect(scrolled).toEqual([]);

		const shown = addTarget('shown');
		const cancelFlash = revealSettingsAnchor(document, 'shown');
		expect(shown.hasAttribute(SETTINGS_FLASH_ATTRIBUTE)).toBe(true);
		cancelFlash();
		expect(shown.hasAttribute(SETTINGS_FLASH_ATTRIBUTE)).toBe(false);
	});
});
