// @vitest-environment happy-dom
/**
 * TOAST CARDS FIT A PHONE.
 *
 * The stack used to sit `bottom-6 right-6` with every card at `min-w-[280px]`,
 * so on a 280–304px screen the card ran off the left edge, and nothing kept it
 * clear of the home indicator or a landscape notch. happy-dom does no layout,
 * so what this pins is the class contract the geometry rests on (the real
 * check is the narrow-viewport screenshots in the PR):
 *
 *  - phones: the stack spans the viewport between 1rem gutters plus the
 *    safe-area insets, and a card fills that width with no fixed minimum;
 *  - `sm` and up: back to the bottom-right corner with the 280px minimum;
 *  - the stack sits above any fixed bottom chrome the app reports through
 *    `--ui-bottom-chrome-height` (the mobile tab bar, #1438), and never lower
 *    than its own inset-aware offset;
 *  - the full-width stack lets taps through the gaps between cards, only the
 *    cards take pointer events;
 *  - message and action wrap as a pair, so a long German message or label
 *    breaks onto a new line instead of widening the card.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import Toast from '../components/ui/Toast.vue';
import { useToast } from '../composables/useToast';
import { mountUi, type MountedUi } from './i18n';

const LONG_DE =
	'Die Nachricht konnte nicht gesendet werden, weil der Empfängerserver die Verbindung abgelehnt hat.';

let mounted: MountedUi | null = null;

afterEach(() => {
	useToast().clearToasts();
	mounted?.unmount();
	mounted = null;
});

async function renderToasts() {
	mounted = mountUi(Toast);
	const onAction = vi.fn();
	const { showToast } = useToast();
	showToast(LONG_DE, 'error', { durationMs: 0 });
	showToast('Unterhaltung archiviert', 'info', {
		durationMs: 0,
		action: { label: 'Rückgängig machen', onAction },
	});
	await nextTick();
	const stack = document.querySelector<HTMLElement>('body > div.fixed');
	if (!stack) throw new Error('toast stack not rendered');
	const cards = [...stack.querySelectorAll<HTMLElement>('[aria-live] > div')];
	return { stack, cards, onAction };
}

describe('Toast stack geometry', () => {
	it('spans the phone viewport between gutters and safe-area insets', async () => {
		const { stack } = await renderToasts();
		const cls = stack.className.split(/\s+/);
		expect(cls).toContain('left-[calc(1rem+env(safe-area-inset-left,0px))]');
		expect(cls).toContain('right-[calc(1rem+env(safe-area-inset-right,0px))]');
		// Never lower than 1.5rem above the inset, and lifted to 0.5rem above any
		// bottom chrome the app reports (the mobile tab bar, #1438).
		expect(cls).toContain(
			'bottom-[max(calc(var(--ui-bottom-chrome-height,0px)+0.5rem),calc(1.5rem+env(safe-area-inset-bottom,0px)))]'
		);
		// The old fixed offsets ignored the insets entirely.
		expect(cls).not.toContain('bottom-6');
		expect(cls).not.toContain('right-6');
	});

	it('returns to the bottom-right corner from sm up, still inside the insets', async () => {
		const { stack } = await renderToasts();
		const cls = stack.className.split(/\s+/);
		expect(cls).toContain('sm:left-auto');
		expect(cls).toContain('sm:right-[calc(1.5rem+env(safe-area-inset-right,0px))]');
	});

	it('lets taps through the stack; only the cards are interactive', async () => {
		const { stack, cards } = await renderToasts();
		expect(stack.classList.contains('pointer-events-none')).toBe(true);
		expect(cards).toHaveLength(2);
		for (const card of cards) expect(card.classList.contains('pointer-events-auto')).toBe(true);
	});

	it('drops the fixed 280px minimum below sm and caps the card at the stack width', async () => {
		const { cards } = await renderToasts();
		for (const card of cards) {
			const cls = card.className.split(/\s+/);
			expect(cls).toContain('w-full');
			expect(cls).toContain('min-w-0');
			expect(cls).toContain('sm:min-w-[280px]');
			expect(cls).not.toContain('min-w-[280px]');
		}
	});

	it('wraps a long message and lets the action drop below it', async () => {
		const { cards } = await renderToasts();
		const actionCard = cards.find((c) => c.textContent?.includes('Rückgängig machen'));
		const message = actionCard?.querySelector('p');
		const row = message?.parentElement;
		expect(row?.classList.contains('flex-wrap')).toBe(true);
		expect(row?.classList.contains('min-w-0')).toBe(true);
		expect(message?.classList.contains('min-w-0')).toBe(true);
		expect(message?.classList.contains('break-words')).toBe(true);
		const action = row?.querySelector('button');
		expect(action?.textContent?.trim()).toBe('Rückgängig machen');
		expect(action?.classList.contains('max-w-full')).toBe(true);
	});

	it('keeps the action behaviour: runs the handler and dismisses the toast', async () => {
		const { cards, onAction } = await renderToasts();
		const actionCard = cards.find((c) => c.textContent?.includes('Rückgängig machen'));
		actionCard?.querySelector<HTMLButtonElement>('p + button')?.click();
		await nextTick();
		expect(onAction).toHaveBeenCalledTimes(1);
		expect(useToast().toasts.value.map((t) => t.message)).toEqual([LONG_DE]);
	});
});
