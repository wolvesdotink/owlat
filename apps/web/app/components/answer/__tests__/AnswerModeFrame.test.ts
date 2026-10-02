// @vitest-environment happy-dom
/**
 * Answer mode's frame: the top bar, the three layouts, the phone tabs and the
 * reply sheet.
 *
 * happy-dom cannot lay anything out, so the width is a stubbed `matchMedia`
 * and what is pinned is structure: which layout renders, both columns always
 * mounted (a tab switch or a lowered sheet must not throw away a draft being
 * typed), which height the sheet is at, and the handle as a button with its
 * keys. The height rules themselves are unit-tested in
 * `utils/__tests__/answerModeLayout.test.ts`.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, useId } from 'vue';

import AnswerModeFrame from '../AnswerModeFrame.vue';
import { auditA11y } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n, useId });
});

const realMatchMedia = window.matchMedia;
const realVisualViewport = window.visualViewport;

/** A viewport `width` px wide, as far as `matchMedia` can tell. */
function setWidth(width: number) {
	window.matchMedia = ((query: string) => {
		const max = /max-width:\s*([\d.]+)px/.exec(query);
		const min = /min-width:\s*([\d.]+)px/.exec(query);
		const matches =
			(max ? width <= Number(max[1]) : true) && (min ? width >= Number(min[1]) : true);
		return {
			matches,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		} as unknown as MediaQueryList;
	}) as typeof window.matchMedia;
}

afterEach(() => {
	window.matchMedia = realMatchMedia;
	Object.defineProperty(window, 'visualViewport', {
		value: realVisualViewport,
		configurable: true,
	});
	document.body.innerHTML = '';
});

function mountFrame(props: Record<string, unknown> = {}) {
	return mount(AnswerModeFrame, {
		attachTo: document.body,
		props: {
			backLabel: 'Inbox',
			subject: 'September invoice, PO BP-2231',
			messageCount: 5,
			counterpart: 'Brightpath Finance',
			...props,
		},
		slots: {
			identity: '<span data-testid="identity">Answering as Ada</span>',
			queue: '<span data-testid="queue">1 of 3</span>',
			menu: '<button data-testid="menu">More</button>',
			conversation: '<p data-testid="thread">the thread</p>',
			composer: '<div contenteditable="true" data-testid="editor"></div>',
		},
		global: { plugins: [createTestI18n()] },
	});
}

/** A pointer event at a given time, since a flick is read from the timing. */
async function pointer(el: Element, type: string, clientY: number, timeStamp: number) {
	const event = new PointerEvent(type, { pointerId: 1, button: 0, clientY, bubbles: true });
	Object.defineProperty(event, 'timeStamp', { value: timeStamp });
	el.dispatchEvent(event);
	await nextTick();
}

type Frame = ReturnType<typeof mountFrame>;
const conversation = (w: Frame) => w.get('[data-testid="answer-conversation-column"]');
const sheet = (w: Frame) => w.get('[data-testid="answer-composer-column"]');
const content = (w: Frame) => w.get('[data-testid="answer-composer-content"]');
const handle = (w: Frame) => w.get('[data-testid="answer-sheet-handle"]');
const lastTab = (w: Frame) => w.emitted('update:tab')?.at(-1)?.[0];

describe('AnswerModeFrame top bar', () => {
	it('shows the subject, the message count and the correspondent', () => {
		setWidth(1440);
		const w = mountFrame();
		expect(w.get('[data-testid="answer-subject"]').text()).toBe('September invoice, PO BP-2231');
		expect(w.text()).toContain('5 messages · Brightpath Finance');
		expect(w.find('[data-testid="identity"]').exists()).toBe(true);
		expect(w.find('[data-testid="queue"]').exists()).toBe(true);
		expect(w.find('[data-testid="menu"]').exists()).toBe(true);
	});

	it('names the way back, hides its key hint from touch, and emits it', async () => {
		setWidth(1440);
		const w = mountFrame();
		const back = w.get('[data-testid="answer-back"]');
		expect(back.attributes('aria-label')).toBe('Back to Inbox');
		expect(back.get('kbd').text()).toBe('Esc');
		expect(back.get('kbd').classes()).toContain('pointer-coarse:hidden');
		await back.trigger('click');
		expect(w.emitted('back')).toHaveLength(1);
	});

	it('says "1 message" for a single email and nothing while the count loads', () => {
		setWidth(1440);
		expect(mountFrame({ messageCount: 1, counterpart: '' }).text()).toContain('1 message');
		const loading = mountFrame({ messageCount: undefined, counterpart: '' });
		expect(loading.text()).not.toContain('message');
	});

	it('keeps the phone bar to one line: back, subject, queue position', () => {
		setWidth(390);
		const w = mountFrame();
		expect(w.find('[data-testid="answer-meta"]').exists()).toBe(false);
		expect(w.find('[data-testid="queue"]').exists()).toBe(true);
	});
});

describe('AnswerModeFrame side by side (from 1100px)', () => {
	it('has no tabs and no sheet, and shows both columns', () => {
		setWidth(1440);
		const w = mountFrame();
		expect(w.get('[data-testid="answer-mode"]').attributes('data-layout')).toBe('split');
		expect(w.find('[role="tablist"]').exists()).toBe(false);
		expect(w.find('[data-testid="answer-sheet-handle"]').exists()).toBe(false);
		expect(sheet(w).attributes('data-sheet-state')).toBeUndefined();
		expect(conversation(w).classes()).not.toContain('hidden');
		expect(content(w).classes()).not.toContain('hidden');
	});
});

describe('AnswerModeFrame on a phone', () => {
	it('opens on the conversation with the reply waiting as one row', () => {
		setWidth(390);
		const w = mountFrame();
		expect(w.get('[data-testid="answer-mode"]').attributes('data-layout')).toBe('phone');
		expect(w.get('[data-testid="answer-tab-conversation"]').attributes('aria-selected')).toBe(
			'true'
		);
		expect(sheet(w).attributes('data-sheet-state')).toBe('peek');
		expect(conversation(w).classes()).not.toContain('hidden');
		expect(w.get('[data-testid="answer-sheet-peek"]').text()).toBe('Reply to Brightpath Finance…');
		// Folded, not unmounted: the draft survives. Its window-wide keys stand down.
		expect(content(w).classes()).toContain('hidden');
		expect(content(w).attributes('data-sheet-hidden')).toBe('');
		expect(content(w).find('[data-testid="editor"]').exists()).toBe(true);
	});

	it('fills the screen with the reply on the Reply tab, keeping the thread mounted', async () => {
		setWidth(390);
		const w = mountFrame();
		await w.get('[data-testid="answer-tab-reply"]').trigger('click');
		expect(lastTab(w)).toBe('reply');
		await w.setProps({ tab: 'reply' });
		expect(sheet(w).attributes('data-sheet-state')).toBe('full');
		expect(conversation(w).classes()).toContain('hidden');
		expect(conversation(w).find('[data-testid="thread"]').exists()).toBe(true);
		expect(content(w).classes()).not.toContain('hidden');

		await w.setProps({ tab: 'conversation' });
		expect(sheet(w).attributes('data-sheet-state')).toBe('peek');
	});

	it('goes straight to the Reply tab when the page asks (Cmd/Ctrl+J)', async () => {
		setWidth(390);
		const w = mountFrame({ tab: 'conversation' });
		await w.setProps({ tab: 'reply' });
		expect(sheet(w).attributes('data-sheet-state')).toBe('full');
	});

	it('raises the reply over the conversation from its row and puts the caret in it', async () => {
		setWidth(390);
		let shownAtFocus: boolean | null = null;
		const w = mountFrame({
			// The page focuses the body through its composer, inside the tap.
			'onStart-reply': () => {
				const el = content(w).element as HTMLElement;
				shownAtFocus = el.style.display === 'flex' || !el.classList.contains('hidden');
				(w.get('[data-testid="editor"]').element as HTMLElement).focus();
			},
		});
		// The row's click handler runs start-reply before the click returns.
		(w.get('[data-testid="answer-sheet-peek"]').element as HTMLElement).click();
		expect(w.emitted('start-reply')).toHaveLength(1);
		// The composer was already out of display:none when the focus was asked for.
		expect(shownAtFocus).toBe(true);
		await nextTick();
		await nextTick();
		expect((content(w).element as HTMLElement).style.display).toBe('');
		expect(sheet(w).attributes('data-sheet-state')).toBe('half');
		// Both in view: the email to glance at, the reply to type in.
		expect(conversation(w).classes()).not.toContain('hidden');
		expect(content(w).classes()).not.toContain('hidden');
		expect(sheet(w).classes()).toContain('h-[55%]');
		expect(document.activeElement).toBe(w.get('[data-testid="editor"]').element);
		// Still the Conversation tab: only the full sheet is Reply.
		expect(w.emitted('update:tab')).toBeUndefined();
	});

	it('offers the peek row a slot for the AI entry', () => {
		setWidth(390);
		const w = mount(AnswerModeFrame, {
			props: { backLabel: 'Inbox', subject: 'Hi' },
			slots: { 'peek-actions': '<button data-testid="draft-ai">Draft</button>' },
			global: { plugins: [createTestI18n()] },
		});
		expect(w.find('[data-testid="draft-ai"]').exists()).toBe(true);
		expect(w.get('[data-testid="answer-sheet-peek"]').text()).toBe('Write a reply…');
	});

	it('says what the reply waits on when the page names it', () => {
		setWidth(390);
		const w = mount(AnswerModeFrame, {
			props: {
				backLabel: 'Inbox',
				subject: 'Hi',
				counterpart: 'Jonas',
				peekText: 'Answer the questions for this reply…',
			},
			global: { plugins: [createTestI18n()] },
		});
		expect(w.get('[data-testid="answer-sheet-peek"]').text()).toBe(
			'Answer the questions for this reply…'
		);
	});
});

describe('AnswerModeFrame sheet handle', () => {
	it('is a button that says what it does and what it controls', () => {
		setWidth(390);
		const w = mountFrame();
		const grip = handle(w);
		expect(grip.element.tagName).toBe('BUTTON');
		expect(grip.attributes('aria-expanded')).toBe('false');
		expect(grip.attributes('aria-controls')).toBe(sheet(w).attributes('id'));
		expect(grip.attributes('aria-label')).toBe('Show the reply');
		expect(grip.attributes('aria-keyshortcuts')).toBe('ArrowUp ArrowDown');
		const hint = w.get(`#${grip.attributes('aria-describedby')}`);
		expect(hint.text()).toContain('arrow keys');
	});

	it('toggles on a tap and steps with the arrow keys', async () => {
		setWidth(390);
		const w = mountFrame();
		await handle(w).trigger('click');
		expect(sheet(w).attributes('data-sheet-state')).toBe('half');
		expect(handle(w).attributes('aria-expanded')).toBe('true');
		expect(handle(w).attributes('aria-label')).toBe('Lower the reply');

		await handle(w).trigger('keydown', { key: 'ArrowUp' });
		expect(sheet(w).attributes('data-sheet-state')).toBe('full');
		expect(lastTab(w)).toBe('reply');
		expect(handle(w).attributes('aria-label')).toBe('Make the reply smaller');

		await handle(w).trigger('keydown', { key: 'ArrowDown' });
		await handle(w).trigger('keydown', { key: 'ArrowDown' });
		expect(sheet(w).attributes('data-sheet-state')).toBe('peek');
		expect(lastTab(w)).toBe('conversation');
	});

	it('carries a flick on to the next height', async () => {
		setWidth(390);
		const w = mountFrame();
		const body = sheet(w).element.parentElement!;
		body.getBoundingClientRect = () => ({ height: 600 }) as DOMRect;
		sheet(w).element.getBoundingClientRect = () => ({ height: 60 }) as DOMRect;
		const row = w.get('[data-testid="answer-sheet-handle-row"]');
		row.element.getBoundingClientRect = () => ({ height: 60 }) as DOMRect;
		// 40px up in 20ms: barely off the peek row, but fast.
		await pointer(row.element, 'pointerdown', 700, 0);
		await pointer(row.element, 'pointermove', 680, 10);
		await pointer(row.element, 'pointermove', 660, 20);
		await pointer(row.element, 'pointerup', 660, 25);
		expect(sheet(w).attributes('data-sheet-state')).toBe('half');
	});

	it('leaves a mouse click on "Reply to …" to the button: no pointer capture until a drag starts', async () => {
		setWidth(390);
		const w = mountFrame({ 'onStart-reply': () => {} });
		const row = w.get('[data-testid="answer-sheet-handle-row"]');
		const captured: number[] = [];
		(row.element as HTMLElement).setPointerCapture = (id: number) => void captured.push(id);
		// A captured pointer's click goes to the row, not the button under it.
		await pointer(w.get('[data-testid="answer-sheet-peek"]').element, 'pointerdown', 700, 0);
		await pointer(w.get('[data-testid="answer-sheet-peek"]').element, 'pointerup', 700, 30);
		expect(captured).toEqual([]);
		await w.get('[data-testid="answer-sheet-peek"]').trigger('click');
		expect(w.emitted('start-reply')).toHaveLength(1);
		expect(sheet(w).attributes('data-sheet-state')).toBe('half');

		// A real drag does capture, so it keeps following off the row.
		await pointer(row.element, 'pointerdown', 700, 100);
		await pointer(row.element, 'pointermove', 650, 150);
		expect(captured).toEqual([1]);
	});

	it('follows a drag and settles on the nearest height, without a stray tap', async () => {
		setWidth(390);
		const w = mountFrame();
		const body = sheet(w).element.parentElement!;
		const rect = (height: number) => () => ({ height }) as DOMRect;
		body.getBoundingClientRect = rect(600);
		sheet(w).element.getBoundingClientRect = rect(60);
		w.get('[data-testid="answer-sheet-handle-row"]').element.getBoundingClientRect = rect(60);

		const row = w.get('[data-testid="answer-sheet-handle-row"]');
		await pointer(row.element, 'pointerdown', 700, 0);
		await pointer(row.element, 'pointermove', 500, 400);
		// Live: the finger's height, not a state.
		expect(sheet(w).attributes('style')).toContain('height: 260px');
		expect(content(w).classes()).not.toContain('hidden');
		// Slowly on to 340px (half is 330px of the 600px body), then let go.
		await pointer(row.element, 'pointermove', 420, 800);
		await pointer(row.element, 'pointerup', 420, 1000);
		expect(sheet(w).attributes('data-sheet-state')).toBe('half');
		expect(sheet(w).attributes('style') ?? '').not.toContain('height: 340px');

		// The click the drag ends in is not also a tap on the grip.
		await handle(w).trigger('click');
		expect(sheet(w).attributes('data-sheet-state')).toBe('half');
	});
});

describe('AnswerModeFrame stacked (768 to 1100px)', () => {
	it('starts with the composer up as a sheet that grows with the draft', () => {
		setWidth(1000);
		const w = mountFrame();
		expect(w.get('[data-testid="answer-mode"]').attributes('data-layout')).toBe('stacked');
		expect(w.find('[role="tablist"]').exists()).toBe(false);
		expect(sheet(w).attributes('data-sheet-state')).toBe('half');
		expect(sheet(w).classes()).toEqual(expect.arrayContaining(['min-h-56', 'max-h-[60%]']));
		expect(sheet(w).classes()).not.toContain('h-[55%]');
		expect(content(w).classes()).not.toContain('hidden');
	});

	it('lowers out of the way and comes back for Cmd/Ctrl+J', async () => {
		setWidth(1000);
		const w = mountFrame();
		await handle(w).trigger('click');
		expect(sheet(w).attributes('data-sheet-state')).toBe('peek');
		expect(lastTab(w)).toBe('conversation');
		await w.setProps({ tab: 'conversation' });

		await w.setProps({ tab: 'reply' });
		expect(sheet(w).attributes('data-sheet-state')).toBe('half');
	});
});

describe('AnswerModeFrame and the on-screen keyboard', () => {
	it('leaves the keyboard out of its height so Send stays above it', () => {
		setWidth(390);
		Object.defineProperty(window, 'visualViewport', {
			configurable: true,
			value: {
				height: window.innerHeight - 300,
				offsetTop: 0,
				scale: 1,
				addEventListener: () => {},
				removeEventListener: () => {},
			},
		});
		const w = mountFrame();
		const frame = w.get('[data-testid="answer-mode"]');
		const style = frame.attributes('style') ?? '';
		expect(style).toContain('--answer-keyboard-inset: 300px');
		expect(frame.classes().join(' ')).toContain('var(--answer-keyboard-inset,0px)');
		// Under an open keyboard the home indicator needs no room.
		expect(style).toContain('--answer-bottom-inset: 0px');
	});

	it('keeps room for the home indicator while no keyboard is up', () => {
		setWidth(390);
		const w = mountFrame();
		const style = w.get('[data-testid="answer-mode"]').attributes('style') ?? '';
		expect(style).toContain('safe-area-inset-bottom');
		expect(sheet(w).classes()).toContain('pb-(--answer-bottom-inset)');
	});
});

describe('AnswerModeFrame accessibility', () => {
	for (const width of [390, 1000, 1440]) {
		it(`has no axe violations at ${width}px`, async () => {
			setWidth(width);
			const violations = await auditA11y(AnswerModeFrame, {
				props: { backLabel: 'Inbox', subject: 'September invoice', messageCount: 5 },
				slots: {
					conversation: '<p>the thread</p>',
					composer: '<label>Reply <textarea></textarea></label>',
				},
				global: { plugins: [createTestI18n()] },
			});
			expect(violations).toEqual([]);
		});
	}
});
