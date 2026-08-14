// @vitest-environment happy-dom
/**
 * THE DAY-OF-N LINE (deliverability plan D14, P3-7).
 *
 * A multi-day send is a NORMAL, VISIBLE state for a warming deployment. This
 * suite is a copy-and-treatment audit of the component itself — the pure
 * derivation has its own suite (`campaignDayOfN.test.ts`), and what is asserted
 * here is what the component does with it:
 *
 *   - it renders NOTHING when there is no walk in flight, and nothing for an
 *     ordinary same-day send: absence of a plan is not a state to explain;
 *   - it is never an error treatment — no warning colour, no alert role, no
 *     "setup incomplete" nag (plan D2);
 *   - a bounded audience count is rendered as the FLOOR it is;
 *   - a truncated plan is never quoted as a finish date.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import CampaignSendPlanLine from '../CampaignSendPlanLine.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

// The line renders every sentence through the real catalog, so `useI18n` has to
// resolve exactly as it does in the app (an auto-import, hence a global).
Object.assign(globalThis, i18nStubs);

interface Progress {
	isMultiDay: boolean;
	day: number;
	totalDays: number;
	enqueued: number;
	total: number;
	isTotalLowerBound: boolean;
	isTruncated: boolean;
}

function progress(overrides: Partial<Progress> = {}): Progress {
	return {
		isMultiDay: true,
		day: 1,
		totalDays: 4,
		enqueued: 5_000,
		total: 20_000,
		isTotalLowerBound: false,
		isTruncated: false,
		...overrides,
	};
}

function render(value: Progress | null | undefined) {
	return mount(CampaignSendPlanLine, {
		props: { progress: value },
		global: { plugins: [createTestI18n()] },
	});
}

describe('CampaignSendPlanLine — when it renders at all', () => {
	it('renders nothing when there is no walk in flight', () => {
		expect(render(null).text()).toBe('');
		expect(render(undefined).text()).toBe('');
	});

	it('renders nothing for an ordinary same-day send', () => {
		expect(render(progress({ isMultiDay: false, totalDays: 1 })).text()).toBe('');
	});

	it('is present from the FIRST hop, before anything has been enqueued', () => {
		const text = render(progress({ enqueued: 0 })).text();
		expect(text).toContain('Sending over 4 days');
		expect(text).toContain('day 1 of 4');
	});
});

describe('CampaignSendPlanLine — it is never an error state', () => {
	it('carries no alert role and no warning treatment', () => {
		const wrapper = render(progress());
		expect(wrapper.attributes('role')).toBeUndefined();
		const html = wrapper.html();
		expect(html).not.toMatch(/error|warning|danger|alert/i);
		// Nothing to dismiss, nothing to fix: the line is a sentence, not a task.
		expect(wrapper.findAll('button')).toHaveLength(0);
	});
});

describe('CampaignSendPlanLine — it says the quiet part', () => {
	// Formatted through the same idiom as the neighbouring recipient count, so the
	// expectations are derived rather than hard-coded to one locale.
	const n = (value: number) => value.toLocaleString();

	it('renders a counted audience as a plain denominator', () => {
		expect(render(progress()).text()).toContain(`${n(5_000)} of ${n(20_000)}`);
	});

	it('renders a BOUNDED audience count as the floor it is', () => {
		const text = render(progress({ total: 1_500, isTotalLowerBound: true })).text();
		expect(text).toContain(`of at least ${n(1_500)}`);
	});

	it('quotes no denominator at all when there is none', () => {
		const text = render(progress({ total: 0, enqueued: 5_000 })).text();
		expect(text).toContain(`${n(5_000)} sent`);
		expect(text).not.toContain('of 0');
	});

	it('never quotes a truncated plan as a finish date', () => {
		const text = render(progress({ totalDays: 60, isTruncated: true })).text();
		expect(text).toContain('more than 60 days');
	});
});
