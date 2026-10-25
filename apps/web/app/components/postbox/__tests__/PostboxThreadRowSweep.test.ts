/**
 * PostboxThreadRow — the row half of a sweep. The row offers a press on its
 * checkbox or Archive button to the list (`sweep-start`), refuses its own
 * native drag for that press, and paints what a sweep in flight will do to it
 * (`sweepMark`). The sweep itself is pinned in usePostboxSweep.test.ts.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { tooltipOf } from '~/__tests__/tooltip';
import type { PostboxSweepMark } from '~/utils/postboxSweep';

import PostboxThreadRow, { type PostboxThreadRowMessage } from '../PostboxThreadRow.vue';
import PostboxRowCore from '../PostboxRowCore.vue';
import PostboxThreadRowBody from '../PostboxThreadRowBody.vue';
import PostboxSwipeTrack from '../PostboxSwipeTrack.vue';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const MSG: PostboxThreadRowMessage = {
	_id: 'msg-1' as Id<'mailMessages'>,
	fromAddress: 'ana@example.com',
	fromName: 'Ana',
	subject: 'Weekly digest',
	snippet: 'This week…',
	receivedAt: 1_700_000_000_000,
	flagSeen: true,
	flagFlagged: false,
	hasAttachments: false,
};

function mountRow(props: { selected?: boolean; sweepMark?: PostboxSweepMark | null } = {}) {
	return mount(PostboxThreadRow, {
		props: {
			msg: MSG,
			folderRole: 'inbox',
			virtualize: false,
			selected: props.selected ?? false,
			focused: false,
			active: false,
			sweepMark: props.sweepMark ?? null,
		},
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxRowCore,
				PostboxThreadRowBody,
				PostboxSwipeTrack,
				Icon: { props: ['name'], template: '<span :data-icon="name" />' },
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				UiContextMenu: {
					props: ['items'],
					template: '<slot :on-contextmenu="() => {}" :on-keydown="() => {}" />',
				},
				UiAvatar: { props: ['name', 'email', 'size'], template: '<span />' },
				PostboxThreadRowFollowUp: { template: '<span />' },
			},
			mocks: { resolveComponent: () => 'a' },
		},
	});
}

function mousedown(target: Element) {
	const event = new Event('pointerdown', { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		pointerType: { value: 'mouse' },
		pointerId: { value: 1 },
		isPrimary: { value: true },
		button: { value: 0 },
		clientX: { value: 0 },
		clientY: { value: 0 },
	});
	target.dispatchEvent(event);
	return event;
}

function dragstart(row: Element) {
	const event = new Event('dragstart', { bubbles: true, cancelable: true });
	row.dispatchEvent(event);
	return event;
}

const archiveButton = (w: ReturnType<typeof mountRow>) =>
	w.find('[data-sweep-handle="archive"]').element;

describe('PostboxThreadRow sweep handles', () => {
	it('offers a press on the checkbox as a selection sweep', () => {
		const w = mountRow();
		const event = mousedown(w.find('.pbx-row-checkbox').element);
		expect(w.emitted('sweep-start')).toEqual([['select', event]]);
	});

	it('offers a press on the hover Archive button (or its icon) as an archive sweep', () => {
		const w = mountRow();
		mousedown(archiveButton(w).firstElementChild ?? archiveButton(w));
		expect(w.emitted('sweep-start')?.[0]?.[0]).toBe('archive');
	});

	it('offers nothing for a press on the row body or the other quick actions', () => {
		const w = mountRow();
		mousedown(w.find('.pbx-row-link').element);
		mousedown(w.find('[aria-label="Delete"]').element);
		expect(w.emitted('sweep-start')).toBeUndefined();
	});

	it('refuses the row drag for a press that began on a handle', () => {
		const w = mountRow();
		const row = w.find('.pbx-row-li').element;
		mousedown(w.find('.pbx-row-checkbox').element);
		expect(dragstart(row).defaultPrevented).toBe(true);
		expect(w.emitted('drag-start')).toBeUndefined();
	});

	it('still picks the row up for the folder rail from anywhere else', () => {
		const w = mountRow();
		const row = w.find('.pbx-row-li').element;
		mousedown(w.find('.pbx-row-checkbox').element);
		mousedown(w.find('.pbx-row-link').element);
		expect(dragstart(row).defaultPrevented).toBe(false);
		expect(w.emitted('drag-start')).toHaveLength(1);
	});

	it('says on both handles that they sweep', () => {
		const w = mountRow();
		expect(tooltipOf(w, w.find('.pbx-row-checkbox'))).toContain('drag across rows');
		expect(tooltipOf(w, archiveButton(w))).toContain('drag across rows');
		expect(w.find('.pbx-row-checkbox').attributes('title')).toBeUndefined();
		expect(archiveButton(w).getAttribute('title')).toBeNull();
		// The accessible names stay the verbs.
		expect(archiveButton(w).getAttribute('aria-label')).toBe('Archive');
	});
});

describe('PostboxThreadRow sweep preview', () => {
	it('shows the box ticked while a selecting sweep covers the row', () => {
		const w = mountRow({ sweepMark: 'select' });
		expect(w.find('.pbx-row-checkbox [data-icon="lucide:check"]').exists()).toBe(true);
		expect(w.find('.pbx-row-link').classes()).toContain('bg-brand/5');
		// Nothing is selected yet: the accessible state does not run ahead.
		expect(w.find('.pbx-row-checkbox').attributes('aria-label')).toBe('Select');
	});

	it('shows the box cleared while a deselecting sweep covers a selected row', () => {
		const w = mountRow({ selected: true, sweepMark: 'deselect' });
		expect(w.find('.pbx-row-checkbox [data-icon="lucide:check"]').exists()).toBe(false);
		expect(w.find('.pbx-row-link').classes()).not.toContain('bg-brand/5');
	});

	it('fades a row an Archive sweep is about to take', () => {
		const w = mountRow({ sweepMark: 'archive' });
		expect(w.find('.pbx-row-link').classes()).toContain('opacity-40');
		expect(w.find('.pbx-row-li').attributes('data-sweep-mark')).toBe('archive');
	});

	it('marks the row for the sweep hit-test, and paints nothing at rest', () => {
		const w = mountRow();
		expect(w.find('.pbx-row-li').attributes('data-sweep-row')).toBe('msg-1');
		expect(w.find('.pbx-row-li').attributes('data-sweep-mark')).toBeUndefined();
		expect(w.find('.pbx-row-link').classes()).not.toContain('opacity-40');
	});
});
