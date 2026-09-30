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

const stubs = { Icon: { template: '<i />' }, UiErrorAlert: true };

/** The inline page reached the end: nothing is counting in the background. */
const LIVE = { status: 'not_needed' } as const;

function mountPicker(audienceCount: RecipientCount | null, selectedTopicId: string | null = null) {
	return mount(SetupAudiencePicker, {
		props: {
			topics: [],
			segments: [],
			audienceCount,
			error: null,
			audienceType: 'topic' as const,
			selectedTopicId: selectedTopicId as never,
			selectedSegmentId: null,
		},
		global: { plugins: [createTestI18n()], stubs },
	});
}

function renderCount(audienceCount: RecipientCount | null): string {
	return mountPicker(audienceCount).find('[data-testid="audience-eligible-count"]').text();
}

describe('SetupAudiencePicker — the eligible-recipient readout', () => {
	it('renders an exact count as a plain number', () => {
		expect(
			renderCount({ eligible: 1234, total: 1300, completeness: 'exact', background: LIVE })
		).toBe('1,234');
	});

	it('marks a capped enumeration as a lower bound', () => {
		expect(
			renderCount({
				eligible: 25_000,
				total: 25_000,
				completeness: 'candidate_capped',
				background: LIVE,
			})
		).toBe('25,000+');
	});

	it('marks a budget-stopped enumeration as a lower bound', () => {
		expect(
			renderCount({
				eligible: 3_000,
				total: 3_000,
				completeness: 'read_budget_exhausted',
				background: LIVE,
			})
		).toBe('3,000+');
	});

	/** An OVER-count bounds nothing from below — "at least" would be a lie. */
	it('never marks a truncated suppression set as a lower bound', () => {
		expect(
			renderCount({
				eligible: 600,
				total: 600,
				completeness: 'suppression_truncated',
				background: LIVE,
			})
		).toBe('600');
	});

	it('renders zero while the count is still loading', () => {
		expect(renderCount(null)).toBe('0');
	});
});

describe('SetupAudiencePicker — the background exact count (#916)', () => {
	function status(audienceCount: RecipientCount) {
		const wrapper = mountPicker(audienceCount, 'topic_1');
		return {
			count: wrapper.find('[data-testid="audience-eligible-count"]').text(),
			status: wrapper.find('[data-testid="audience-count-status"]'),
			text: wrapper.text(),
		};
	}

	it('shows the inline page as "at least" and says the full count is running', () => {
		const shown = status({
			eligible: 724,
			total: 1_000,
			completeness: 'read_budget_exhausted',
			background: { status: 'unavailable' },
		});
		expect(shown.count).toBe('724+');
		expect(shown.status.text()).toContain('Counting every matching contact');
	});

	it('shows the running total as "at least" while the job counts', () => {
		const shown = status({
			eligible: 14_500,
			total: 20_000,
			completeness: 'read_budget_exhausted',
			background: { status: 'counting', startedAt: 1, retryAfter: 2 },
		});
		expect(shown.count).toBe('14,500+');
		expect(shown.status.exists()).toBe(true);
		// Two lower bounds say nothing about the excluded gap.
		expect(shown.text).not.toContain('not eligible');
	});

	it('shows a finished count as exact, with the time it was taken', () => {
		const countedAt = new Date(2026, 8, 30, 14, 5).getTime();
		const shown = status({
			eligible: 36_246,
			total: 50_000,
			completeness: 'exact',
			background: { status: 'complete', countedAt, retryAfter: countedAt + 1 },
		});
		expect(shown.count).toBe('36,246');
		expect(shown.status.text()).toMatch(/^Counted at 2:05/);
		expect(shown.text).toContain('13,754 of 50,000 contacts in this topic are not eligible');
	});

	it('says nothing extra when the inline page was already the whole audience', () => {
		const shown = status({ eligible: 12, total: 14, completeness: 'exact', background: LIVE });
		expect(shown.count).toBe('12');
		expect(shown.status.exists()).toBe(false);
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

describe('SetupAudiencePicker — a failed topics or segments read (#818)', () => {
	const alertStub = {
		UiErrorAlert: {
			props: ['message', 'actionLabel'],
			emits: ['action'],
			template:
				'<div data-testid="audience-load-failed">{{ message }}<button @click="$emit(\'action\')">{{ actionLabel }}</button></div>',
		},
	};

	function mountFailed() {
		return mount(SetupAudiencePicker, {
			props: {
				topics: [],
				segments: [],
				audienceCount: null,
				error: null,
				loadFailed: true,
				audienceType: 'topic' as const,
				selectedTopicId: null,
				selectedSegmentId: null,
			},
			global: { plugins: [createTestI18n()], stubs: { ...stubs, ...alertStub } },
		});
	}

	it('says the lists failed to load instead of claiming there are none', () => {
		const wrapper = mountFailed();
		expect(wrapper.find('[data-testid="audience-load-failed"]').text()).toContain(
			'Could not load your topics and segments.'
		);
		expect(wrapper.find('[data-testid="audience-empty"]').exists()).toBe(false);
	});

	it('asks the parent to retry from its Try again control', async () => {
		const wrapper = mountFailed();
		const button = wrapper.find('[data-testid="audience-load-failed"] button');
		expect(button.text()).toBe('Try again');
		await button.trigger('click');
		expect(wrapper.emitted('retry')).toHaveLength(1);
	});
});
