// @vitest-environment happy-dom
/**
 * Co-editing surfaces (docs/adr/0071-email-coediting.md): the avatar stack of
 * who else is in the editor, and the "your change was replaced" notice with
 * its two ways out. Mounted against the real English catalog, so a missing
 * key fails here instead of rendering its path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import EditorPresence from '../EditorPresence.vue';
import CoeditNotices from '../CoeditNotices.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { EditorPerson } from '~/composables/useEmailEditorPresence';
import type { CoeditNoticeView } from '~/composables/useEmailEditorCoedit';

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const buttonStub = {
	emits: ['click'],
	template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
};

const person = (userId: string, name: string, isEditing = false): EditorPerson => ({
	userId,
	name,
	email: `${userId}@example.com`,
	image: null,
	color: '#3f6480',
	isEditing,
});

function mountPresence(people: EditorPerson[], isOffline = false) {
	return mount(EditorPresence, {
		props: { people, isOffline },
		global: {
			plugins: [createTestI18n()],
			stubs: { UiAvatar: { props: ['name'], template: '<i>{{ name }}</i>' }, Icon: true },
		},
	});
}

describe('EmailEditorPresence', () => {
	it('renders nothing when nobody else is here', () => {
		expect(mountPresence([]).find('[data-testid="editor-presence"]').exists()).toBe(false);
	});

	it('names each person and whether they are editing', () => {
		const wrapper = mountPresence([person('u1', 'Alex', true), person('u2', 'Sam')]);
		const items = wrapper.findAll('[role="listitem"]');
		expect(items.map((item) => item.attributes('aria-label'))).toEqual([
			'Alex is editing a block',
			'Sam has this email open',
		]);
	});

	it('folds people past four into a count', () => {
		const people = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => person(id, id.toUpperCase()));
		expect(mountPresence(people).text()).toContain('+2');
	});

	it('says when edits are not synced', () => {
		expect(mountPresence([], true).text()).toContain('Not synced');
	});
});

describe('EmailCoeditNotices', () => {
	const notice = (overrides: Partial<CoeditNoticeView> = {}): CoeditNoticeView => ({
		noticeId: 'n1' as never,
		kind: 'block',
		field: null,
		replacedBy: 'Alex',
		...overrides,
	});

	function mountNotices(notices: CoeditNoticeView[], hasVersionHistory = false) {
		return mount(CoeditNotices, {
			props: { notices, hasVersionHistory },
			global: { plugins: [createTestI18n()], stubs: { UiButton: buttonStub, Icon: true } },
		});
	}

	it('tells whose edit replaced a block change, and where the old one is kept', () => {
		const wrapper = mountNotices([notice()], true);
		expect(wrapper.text()).toContain(
			'Your change to a block was replaced by Alex, who edited it at the same time.'
		);
		expect(wrapper.text()).toContain('Your version is also saved in version history.');
	});

	it('names the field for a field change', () => {
		const wrapper = mountNotices([notice({ kind: 'field', field: 'subject' })]);
		expect(wrapper.text()).toContain('Your change to the subject was replaced by Alex');
		expect(wrapper.text()).not.toContain('version history');
	});

	it('emits restore and dismiss with the notice id', async () => {
		const wrapper = mountNotices([notice()]);
		const [restore, dismiss] = wrapper.findAll('button');
		await restore!.trigger('click');
		await dismiss!.trigger('click');
		expect(wrapper.emitted('restore')).toEqual([['n1']]);
		expect(wrapper.emitted('dismiss')).toEqual([['n1']]);
	});
});
