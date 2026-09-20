// @vitest-environment happy-dom
/**
 * THE NETWORK-PORTS CARD.
 *
 * The card exists because a blocked port is invisible from inside the app, so
 * the failures worth pinning are the ones that would make it lie:
 *
 *  - probing on mount. Every check opens a connection to a third party; a card
 *    that ran them because somebody opened the page would dial Google's mail
 *    servers on every navigation.
 *  - counting an optional port's failure as a fault. A stock VPS blocks
 *    outbound 25; on an instance that sends through an API provider that is
 *    correct, not broken, and a red card there trains operators to ignore it.
 *  - saying "open" for inbound. Inbound is probed from inside the compose
 *    network, which proves the service listens and nothing about whether the
 *    internet reaches it.
 */
import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import PortChecksCard from '../system/PortChecksCard.vue';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('~/lib/csrfFetch', () => ({ apiFetch: apiFetchMock }));

beforeAll(() => {
	Object.assign(globalThis, { ...i18nStubs, computed, ref });
});

beforeEach(() => {
	apiFetchMock.mockReset();
});

function check(overrides: Record<string, unknown> = {}) {
	return {
		id: 'outbound-imaps',
		direction: 'outbound',
		port: 993,
		protocol: 'IMAPS',
		target: 'imap.gmail.com',
		relevance: 'required',
		status: 'open',
		durationMs: 12,
		...overrides,
	};
}

function mountCard() {
	return mount(PortChecksCard, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: { template: '<span />' },
				UiButton: {
					template:
						'<button data-testid="port-checks-run" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
}

describe('before anything is checked', () => {
	it('probes nothing on mount and says what the button will do', async () => {
		const w = mountCard();
		await w.vm.$nextTick();

		expect(apiFetchMock).not.toHaveBeenCalled();
		expect(w.find('[data-testid="port-checks-idle"]').exists()).toBe(true);
		expectFullyLocalized(w);
	});
});

describe('after a run', () => {
	async function run(body: Record<string, unknown>) {
		apiFetchMock.mockResolvedValue(body);
		const w = mountCard();
		await w.find('[data-testid="port-checks-run"]').trigger('click');
		await w.vm.$nextTick();
		await w.vm.$nextTick();
		return w;
	}

	it('POSTs to the updater proxy and renders a row per check', async () => {
		const w = await run({
			reachable: true,
			verdict: 'ok',
			checkedAt: Date.now(),
			checks: [
				check(),
				check({ id: 'inbound-https', direction: 'inbound', port: 443, protocol: 'HTTPS' }),
			],
		});

		expect(apiFetchMock).toHaveBeenCalledWith(
			'/api/system/port-checks',
			expect.objectContaining({ method: 'POST' })
		);
		expect(w.find('[data-testid="port-check-outbound-imaps"]').exists()).toBe(true);
		expect(w.find('[data-testid="port-check-inbound-https"]').exists()).toBe(true);
		expectFullyLocalized(w);
	});

	it('says an inbound port is listening, never that it is reachable', async () => {
		const w = await run({
			reachable: true,
			verdict: 'ok',
			checks: [check({ id: 'inbound-smtp', direction: 'inbound', port: 25, protocol: 'SMTP' })],
		});

		const row = w.find('[data-testid="port-check-inbound-smtp"]');
		expect(row.text()).toContain('listening');
		expect(row.text()).not.toContain('open');
	});

	it('calls out a blocked required port and points at the hosting provider', async () => {
		const w = await run({
			reachable: true,
			verdict: 'degraded',
			checks: [check({ status: 'blocked' })],
		});

		const verdict = w.find('[data-testid="port-checks-verdict"]');
		expect(verdict.text()).toContain('1 port');
		expect(verdict.text()).toMatch(/hosting provider/i);
		expectFullyLocalized(w);
	});

	it('does not raise an alarm for an optional port that is blocked', async () => {
		const w = await run({
			reachable: true,
			verdict: 'ok',
			checks: [
				check({
					id: 'outbound-smtp',
					port: 25,
					protocol: 'SMTP',
					relevance: 'optional',
					status: 'blocked',
				}),
			],
		});

		const verdict = w.find('[data-testid="port-checks-verdict"]');
		expect(verdict.text()).toMatch(/is open/i);
		expect(w.find('[data-testid="port-check-outbound-smtp"]').text()).toContain('not needed');
	});

	/**
	 * The failure the card shipped with: a required port that was never measured
	 * (no edge container, a name that did not resolve) is not a blocked port, and
	 * deriving the headline from blocked rows alone painted it green. An operator
	 * reading "every port is open" over an unmeasured row has been told something
	 * false.
	 */
	it('never says all-clear while a required port went unmeasured', async () => {
		const w = await run({
			reachable: true,
			verdict: 'unknown',
			checks: [
				check({
					id: 'inbound-smtp',
					direction: 'inbound',
					port: 25,
					protocol: 'SMTP',
					status: 'skipped',
				}),
			],
		});

		const verdict = w.find('[data-testid="port-checks-verdict"]');
		expect(verdict.text()).not.toMatch(/is open/i);
		expect(verdict.text()).toMatch(/could not be measured/i);
		expectFullyLocalized(w);
	});

	it('recomputes the verdict when the sidecar sent none', async () => {
		// An older updater answers without the field; the card must not fall back
		// to the green branch by omission.
		const w = await run({
			reachable: true,
			checks: [check({ status: 'blocked' })],
		});
		expect(w.find('[data-testid="port-checks-verdict"]').text()).toMatch(/closed/i);
	});

	it('says an outbound refusal was rejected, not that nothing is listening', async () => {
		const w = await run({
			reachable: true,
			verdict: 'degraded',
			checks: [check({ status: 'refused' })],
		});
		const row = w.find('[data-testid="port-check-outbound-imaps"]');
		expect(row.text()).toContain('rejected');
		expect(row.text()).not.toContain('nothing listening');
	});

	it('separates a sidecar that refused from a sidecar that is missing', async () => {
		const w = await run({
			reachable: true,
			error: 'Too many port-check requests. Try again in a minute.',
		});

		const declined = w.find('[data-testid="port-checks-declined"]');
		expect(declined.exists()).toBe(true);
		expect(declined.text()).toContain('Too many port-check requests');
		// The "is the updater container up?" advice belongs to the other branch.
		expect(w.find('[data-testid="port-checks-unreachable"]').exists()).toBe(false);
		expectFullyLocalized(w);
	});

	it('explains itself when the updater sidecar is not there', async () => {
		const w = await run({ reachable: false, error: 'connect ECONNREFUSED' });

		const box = w.find('[data-testid="port-checks-unreachable"]');
		expect(box.exists()).toBe(true);
		expect(box.text()).toContain('connect ECONNREFUSED');
		expect(w.find('[data-testid="port-checks-verdict"]').exists()).toBe(false);
		expectFullyLocalized(w);
	});

	it('surfaces a thrown request as an unreachable sidecar rather than a blank card', async () => {
		apiFetchMock.mockRejectedValue(new Error('Request timed out'));
		const w = mountCard();
		await w.find('[data-testid="port-checks-run"]').trigger('click');
		await w.vm.$nextTick();
		await w.vm.$nextTick();

		expect(w.find('[data-testid="port-checks-unreachable"]').text()).toContain('Request timed out');
	});
});
