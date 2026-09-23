// @vitest-environment happy-dom
/**
 * The recipient readout is no longer one number — a bounded count reports HOW
 * complete it is, and the picker renders that as a `+` suffix ("at least this
 * many"). Three of the four `completeness` values must NOT earn the suffix, and
 * one of those (`suppression_truncated`) is an OVER-count, where "at least"
 * would be actively wrong.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import SetupAudiencePicker from '../SetupAudiencePicker.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

// The picker renders its copy through the real catalog, so `useI18n` has to
// resolve exactly as it does in the app (an auto-import, hence a global).
Object.assign(globalThis, i18nStubs);

/**
 * Derived from the query, exactly as the component derives it — never
 * hand-restated. A fifth `completeness` value added on the server must be a
 * COMPILE ERROR in the suite that decides what each value renders as, not a
 * silent gap.
 */
type RecipientCount = FunctionReturnType<typeof api.campaigns.audienceResolution.countRecipients>;

const stubs = { Icon: { template: '<i />' } };

function renderCount(audienceCount: RecipientCount | null): string {
	const wrapper = mount(SetupAudiencePicker, {
		props: {
			topics: [],
			segments: [],
			audienceCount,
			error: null,
			audienceType: 'topic' as const,
			selectedTopicId: null,
			selectedSegmentId: null,
		},
		global: { plugins: [createTestI18n()], stubs },
	});
	return wrapper.find('[data-testid="audience-eligible-count"]').text();
}

describe('SetupAudiencePicker — the eligible-recipient readout', () => {
	it('renders an exact count as a plain number', () => {
		expect(renderCount({ eligible: 1234, total: 1300, completeness: 'exact' })).toBe('1,234');
	});

	it('marks a capped enumeration as a lower bound', () => {
		expect(renderCount({ eligible: 25_000, total: 25_000, completeness: 'candidate_capped' })).toBe(
			'25,000+'
		);
	});

	it('marks a budget-stopped enumeration as a lower bound', () => {
		expect(
			renderCount({ eligible: 3_000, total: 3_000, completeness: 'read_budget_exhausted' })
		).toBe('3,000+');
	});

	/** An OVER-count bounds nothing from below — "at least" would be a lie. */
	it('never marks a truncated suppression set as a lower bound', () => {
		expect(renderCount({ eligible: 600, total: 600, completeness: 'suppression_truncated' })).toBe(
			'600'
		);
	});

	it('renders zero while the count is still loading', () => {
		expect(renderCount(null)).toBe('0');
	});
});

describe('SetupAudiencePicker — one recipients control (#785)', () => {
	const topics = [
		{ _id: 'topic_1' as never, name: 'Newsletter', contactCount: 1200 },
		{ _id: 'topic_2' as never, name: 'Product updates' },
	];
	const segments = [{ _id: 'segment_1' as never, name: 'Active buyers', cachedCount: 340 }];

	function mountPicker(
		model: {
			audienceType?: 'topic' | 'segment';
			selectedTopicId?: string | null;
			selectedSegmentId?: string | null;
		} = {},
		lists: { topics?: typeof topics; segments?: typeof segments } = {}
	) {
		return mount(SetupAudiencePicker, {
			props: {
				topics: lists.topics ?? topics,
				segments: lists.segments ?? segments,
				audienceCount: null,
				error: null,
				audienceType: model.audienceType ?? 'topic',
				selectedTopicId: (model.selectedTopicId ?? null) as never,
				selectedSegmentId: (model.selectedSegmentId ?? null) as never,
			},
			global: { plugins: [createTestI18n()], stubs },
		});
	}

	it('offers topics and segments in one select, grouped, each with its count', () => {
		const wrapper = mountPicker();
		const select = wrapper.find('[data-testid="audience-picker"]');
		const groups = select.findAll('optgroup');
		expect(groups.map((g) => g.attributes('label'))).toEqual([
			'Topics: people who subscribed',
			'Segments: contacts matching saved filters',
		]);
		const labels = select.findAll('option').map((o) => o.text());
		expect(labels).toEqual([
			'Choose recipients',
			'Everyone subscribed to Newsletter (1,200)',
			'Everyone subscribed to Product updates',
			'Contacts in Active buyers (340)',
		]);
	});

	it('writes a segment pick back as kind + id and clears the topic', async () => {
		const wrapper = mountPicker({ selectedTopicId: 'topic_1' });
		await wrapper.find('[data-testid="audience-picker"]').setValue('segment:segment_1');
		expect(wrapper.emitted('update:audienceType')?.at(-1)).toEqual(['segment']);
		expect(wrapper.emitted('update:selectedSegmentId')?.at(-1)).toEqual(['segment_1']);
		expect(wrapper.emitted('update:selectedTopicId')?.at(-1)).toEqual([null]);
	});

	it('shows the current selection from the models', () => {
		const wrapper = mountPicker({ audienceType: 'segment', selectedSegmentId: 'segment_1' });
		const select = wrapper.find('[data-testid="audience-picker"]').element as HTMLSelectElement;
		expect(select.value).toBe('segment:segment_1');
		expect(wrapper.text()).toContain('no unsubscribe link is added');
	});

	it('links to creating a topic or segment when there are none', () => {
		const wrapper = mountPicker({}, { topics: [], segments: [] });
		expect(wrapper.find('[data-testid="audience-empty"]').text()).toContain(
			'There are no topics or segments yet.'
		);
	});
});
