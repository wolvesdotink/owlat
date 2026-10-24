/**
 * The Workbench lines' context menus ("Updates", "What changed"): the verbs
 * the line's keys run, labelled with those keys, then the conversation's link
 * verbs. Each verb reaches the page through the line's own emits (done, reply
 * anyway) or the peek the page provides, never a copy of their logic.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { TodayChange, TodayLine, TodayModel, TodaySource } from '~/utils/todayDigest';
import { TODAY_PEEK } from '~/utils/todayPeek';
import TodayUpdates from '../TodayUpdates.vue';
import TodayChanges from '../TodayChanges.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const SOURCE: TodaySource = {
	kind: 'team',
	id: 'in_1',
	threadId: 'th_1',
	mailboxId: null,
	fromName: 'Harbor Design',
	fromAddress: 'studio@example.com',
	subject: 'Final files',
	snippet: 'Attached',
	at: 1,
};

const LINE: TodayLine = {
	key: 'line-1',
	lead: 'Harbor Design',
	text: 'Sent the final files',
	isSummary: true,
	sources: [SOURCE],
	inboxId: 'team',
	reason: null,
	at: 1,
	inboundMessageId: 'in_1',
};

const peek = { open: vi.fn(), openThread: vi.fn() };
const global = {
	plugins: [createTestI18n()],
	provide: { [TODAY_PEEK as symbol]: peek },
	stubs: { Icon: true, NuxtLink: true, TodaySourceLink: true },
	mocks: { formatCompactRelativeTime: () => '1h' },
};

/** Each item as `label|key`, the key empty when the item has none. */
const items = () =>
	Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((el) => {
		const key = el.querySelector('kbd')?.textContent ?? '';
		return `${el.querySelector('span')!.textContent}|${key}`;
	});
const pick = (label: string) =>
	Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
		.find((el) => el.querySelector('span')!.textContent === label)!
		.click();

afterEach(() => {
	peek.open.mockClear();
	peek.openThread.mockClear();
});

describe('Updates line menu', () => {
	function mountUpdates(line: TodayLine = LINE) {
		const model = { worth: [line], also: [], alsoHidden: 0 } as unknown as TodayModel;
		return mount(TodayUpdates, { props: { model }, global, attachTo: document.body });
	}

	it('offers the line’s verbs with their keys, then the link verbs', async () => {
		const wrapper = mountUpdates();
		await wrapper.get('[data-today-line]').trigger('contextmenu', { clientX: 5, clientY: 5 });
		expect(items()).toEqual([
			'Peek|Enter',
			'Open conversation|',
			'Reply anyway|R',
			'Done|D',
			'Open in new tab|',
			'Copy link|',
		]);
		wrapper.unmount();
	});

	it('runs the same handlers as the line’s keys and buttons', async () => {
		const wrapper = mountUpdates();
		const line = wrapper.get('[data-today-line]');
		await line.trigger('contextmenu', { clientX: 5, clientY: 5 });
		pick('Done');
		await line.trigger('contextmenu', { clientX: 5, clientY: 5 });
		pick('Reply anyway');
		await line.trigger('contextmenu', { clientX: 5, clientY: 5 });
		pick('Peek');
		expect(wrapper.emitted('done')).toEqual([[LINE]]);
		expect(wrapper.emitted('replyAnyway')).toEqual([[LINE]]);
		expect(peek.open).toHaveBeenCalledWith([SOURCE]);
		wrapper.unmount();
	});

	it('leaves reply out for a line that cannot be answered', async () => {
		const wrapper = mountUpdates({ ...LINE, inboundMessageId: null });
		await wrapper.get('[data-today-line]').trigger('contextmenu', { clientX: 5, clientY: 5 });
		expect(items().map((i) => i.split('|')[0])).not.toContain('Reply anyway');
		wrapper.unmount();
	});
});

describe('What changed row menu', () => {
	it('offers open and done, and done reaches the page', async () => {
		const change: TodayChange = {
			key: 'change-1',
			subject: 'Kestrel rebrand',
			inboxId: 'mb_1',
			newMessages: 1,
			summary: 'They sent the files',
			latest: SOURCE,
			sources: [SOURCE],
			at: 1,
		};
		const wrapper = mount(TodayChanges, {
			props: { changes: [change], hidden: 0 },
			global,
			attachTo: document.body,
		});
		await wrapper.get('[data-today-line]').trigger('contextmenu', { clientX: 5, clientY: 5 });
		expect(items().map((i) => i.split('|')[0])).toEqual([
			'Peek',
			'Open conversation',
			'Done',
			'Open in new tab',
			'Copy link',
		]);
		pick('Done');
		expect(wrapper.emitted('done')).toEqual([[change]]);
		wrapper.unmount();
	});
});
