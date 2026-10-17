// @vitest-environment happy-dom
/**
 * Read on arrival (§3): a row under the Priority view is one line (sender,
 * the brief's lead or ask, else the gist, else the subject, and one state);
 * a row elsewhere shows the gist where it has no brief line.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxThreadRowBody from '../PostboxThreadRowBody.vue';
import { POSTBOX_PRIORITY_ROWS } from '~/utils/postboxPriorityGroups';
import { POSTBOX_BRIEF_LINES } from '~/composables/postbox/usePostboxBriefLines';

vi.mock('~/composables/postbox/usePostboxListClock', () => ({
	usePostboxThreadTimestamp: () => () => '09:12',
}));
vi.mock('~/composables/useLocalized', () => ({ useLocalized: () => (text: string) => text }));

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const BRIEF_TOP = { mode: 'brief', forYou: 0, waiting: 0, isReplyNeeded: false };

function mountRow(
	msg: Record<string, unknown>,
	opts: { priority?: boolean; briefShown?: boolean } = {}
) {
	return mount(PostboxThreadRowBody, {
		props: {
			msg: {
				_id: 'm1',
				fromAddress: 'dhl@example.com',
				fromName: 'DHL',
				subject: 'Your parcel',
				snippet: 'raw snippet',
				receivedAt: Date.UTC(2026, 9, 17, 9),
				flagSeen: true,
				flagFlagged: false,
				...msg,
			} as never,
		},
		global: {
			plugins: [createTestI18n()],
			provide: {
				...(opts.priority ? { [POSTBOX_PRIORITY_ROWS as symbol]: true } : {}),
				...(opts.briefShown !== undefined
					? { [POSTBOX_BRIEF_LINES as symbol]: ref(opts.briefShown) }
					: {}),
			},
			stubs: {
				PostboxRowCore: { template: '<div data-testid="row-core"><slot /></div>' },
				PostboxThreadRowFollowUp: true,
				Icon: true,
			},
		},
	});
}

const GIST = { ...BRIEF_TOP, gist: { text: 'Parcel delivered to the neighbour at no. 14' } };

describe('PostboxThreadRowBody under the Priority view', () => {
	it('shows the subject, not the gist, when the viewer turned the brief off', () => {
		const w = mountRow(
			{ placement: 'updates', briefTop: GIST },
			{ priority: true, briefShown: false }
		);
		const line = w.get('[data-testid="priority-row-line"]');
		expect(line.text()).toBe('Your parcel');
		expect(line.attributes('data-source')).toBe('subject');
		const on = mountRow(
			{ placement: 'updates', briefTop: GIST },
			{ priority: true, briefShown: true }
		);
		expect(on.get('[data-testid="priority-row-line"]').attributes('data-source')).toBe('gist');
	});

	it('is one line: sender, the gist, the time', () => {
		const w = mountRow({ placement: 'updates', briefTop: GIST }, { priority: true });
		expect(w.find('[data-testid="row-core"]').exists()).toBe(false);
		const row = w.get('[data-testid="priority-row"]');
		expect(row.text()).toContain('DHL');
		const line = w.get('[data-testid="priority-row-line"]');
		expect(line.text()).toBe('Parcel delivered to the neighbour at no. 14');
		expect(line.attributes('data-source')).toBe('gist');
		expect(w.get('[data-testid="priority-row-state"]').text()).toBe('09:12');
		expect(row.text()).not.toContain('raw snippet');
	});

	it('leads a Needs-you row with the ask and says "reply"', () => {
		const w = mountRow(
			{
				placement: 'needs_me',
				briefTop: {
					...BRIEF_TOP,
					forYou: 1,
					isReplyNeeded: true,
					top: {
						itemId: 'i1',
						bucket: 'forUs',
						responsibility: 'us',
						text: { en: 'Can you join the Tuesday review?', de: 'Kommst du Dienstag?' },
					},
					latest: { en: 'Jonas set up the review', de: 'Jonas plant das Review' },
				},
			},
			{ priority: true }
		);
		expect(w.get('[data-testid="priority-row-line"]').text()).toBe(
			'Can you join the Tuesday review?'
		);
		expect(w.get('[data-testid="priority-row-state"]').text()).toBe('reply');
	});

	it('falls back to the subject', () => {
		const w = mountRow({ placement: 'today' }, { priority: true });
		expect(w.get('[data-testid="priority-row-line"]').text()).toBe('Your parcel');
	});
});

describe('PostboxThreadRowBody in All mail', () => {
	it('shows the gist where the row has no brief line', () => {
		const w = mountRow({ briefTop: GIST });
		expect(w.get('[data-testid="row-gist-line"]').text()).toBe(
			'Parcel delivered to the neighbour at no. 14'
		);
	});

	it('keeps the snippet when there is no gist', () => {
		const w = mountRow({});
		expect(w.find('[data-testid="row-gist-line"]').exists()).toBe(false);
		expect(w.text()).toContain('raw snippet');
	});
	it('shows the plain snippet, never a brief or gist line, when the viewer turned the brief off', () => {
		const ask = {
			...BRIEF_TOP,
			forYou: 2,
			isReplyNeeded: true,
			top: {
				itemId: 'i1',
				bucket: 'forUs',
				responsibility: 'us',
				text: { en: 'Send the signed quote', de: 'Schick das Angebot' },
			},
		};
		const on = mountRow({ briefTop: ask }, { briefShown: true });
		expect(on.text()).toContain('Send the signed quote');
		for (const briefTop of [ask, GIST]) {
			const off = mountRow({ briefTop }, { briefShown: false });
			expect(off.text()).not.toContain('Send the signed quote');
			expect(off.text()).not.toContain('for you');
			expect(off.find('[data-testid="row-gist-line"]').exists()).toBe(false);
			expect(off.text()).toContain('raw snippet');
		}
	});
});
