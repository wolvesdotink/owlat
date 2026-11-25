/**
 * The automation detail page's notice says how many runs wait for the sending
 * setup and for what, and how many failed in the last 7 days and why the latest
 * one did, each in the runs panel's sentence and linking to the runs panel
 * filtered to those runs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import HealthNotice from '../HealthNotice.vue';
import type { AutomationHealth } from '../HealthSummary.vue';
import { formatDateTime } from '~/utils/formatters';

const WAIT_ENDS = Date.parse('2026-10-21T09:00:00Z');
const route = reactive<{ query: Record<string, string | undefined> }>({ query: { tab: 'x' } });

beforeEach(() => {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => route,
		usePermissions: () => ({ isAdmin: ref(true) }),
	});
});

function mountNotice(health: Partial<AutomationHealth>) {
	return mount(HealthNotice, {
		props: {
			automationId: 'au_welcome' as never,
			health: {
				automationId: 'au_welcome',
				entered: 10,
				failed: 0,
				stalled: 0,
				latestFailure: null,
				waiting: null,
				...health,
			} as AutomationHealth,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				NuxtLink: {
					props: ['to'],
					template: `<a :href="typeof to === 'string' ? to : '?runs=' + to.query.runs + to.hash"><slot /></a>`,
				},
			},
		},
	});
}

describe('automation health notice', () => {
	it('says how many runs wait and for what, and links to them', () => {
		const wrapper = mountNotice({
			waiting: {
				count: 40,
				hasMore: false,
				reasons: [{ reason: 'domain_not_verified', count: 40, until: WAIT_ENDS }],
			},
		});
		const waiting = wrapper.get('[data-testid="automation-health-waiting"]');
		expect(waiting.text()).toContain('40 runs are waiting for the sending setup');
		expect(waiting.text()).toContain(
			`Waiting for the default sender's domain to be verified. The email goes out once it is, or the run gives up on ${formatDateTime(WAIT_ENDS)}.`
		);
		expect(waiting.get('a[href="?runs=waiting#runs"]').text()).toBe('Show waiting runs');
		expect(wrapper.find('[data-testid="automation-health-failed"]').exists()).toBe(false);
	});

	it('gives every reason the runs wait for its own sentence', () => {
		const wrapper = mountNotice({
			waiting: {
				count: 3,
				hasMore: false,
				reasons: [
					{ reason: 'no_default_sender', count: 2, until: WAIT_ENDS },
					{ reason: 'domain_not_verified', count: 1, until: WAIT_ENDS },
				],
			},
		});
		const waiting = wrapper.get('[data-testid="automation-health-waiting"]').text();
		expect(waiting).toContain('Waiting for a default sender to be set.');
		expect(waiting).toContain("Waiting for the default sender's domain to be verified.");
	});

	it('says when it counted only the first runs that wait', () => {
		const wrapper = mountNotice({
			waiting: {
				count: 50,
				hasMore: true,
				reasons: [{ reason: 'no_default_sender', count: 50, until: WAIT_ENDS }],
			},
		});
		expect(wrapper.text()).toContain('More than 50 runs are waiting for the sending setup');
	});

	it('says how many runs failed and why the latest one did, and links to them', () => {
		const wrapper = mountNotice({ failed: 1, latestFailure: 'template_empty' });
		const failed = wrapper.get('[data-testid="automation-health-failed"]');
		expect(failed.text()).toContain('1 run failed in the last 7 days');
		expect(failed.text()).toContain('The email this step sends has no content.');
		expect(failed.get('a[href="?runs=failed#runs"]').text()).toBe('Show failed runs');
		expect(wrapper.find('[data-testid="automation-health-waiting"]').exists()).toBe(false);
	});
});
