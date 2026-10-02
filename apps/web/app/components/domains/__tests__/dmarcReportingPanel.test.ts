// @vitest-environment happy-dom
/**
 * The DMARC reports panel under a domain's DMARC record: what it says in each
 * reporting mode, the "ask for reports" update (same policy and knobs), and the
 * cross-domain authorization record.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import DmarcReportingPanel from '../DmarcReportingPanel.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

let queryArgs: unknown;
const run = vi.fn(async (_args: unknown) => ({ ok: true }));
const showToast = vi.fn();

function setup(overrides: Record<string, unknown> = {}) {
	return {
		domain: 'example.com',
		mode: 'owlat',
		reportAddress: 'dmarc-reports@bounces.example.com',
		externalRua: null,
		rua: 'mailto:dmarc-reports@bounces.example.com',
		hasDmarcRecord: true,
		isRecordRequestingReports: true,
		isRecordCurrent: true,
		authorizationRecord: null,
		lastReportAt: null,
		...overrides,
	};
}

function mountPanel(data: unknown, canManage = true) {
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: unknown) => {
		queryArgs = typeof args === 'function' ? (args as () => unknown)() : args;
		return { data: ref(data), isLoading: ref(false), error: ref(null) };
	});
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	return mount(DmarcReportingPanel, {
		props: {
			domainId: 'domain_1',
			domain: 'example.com',
			dmarcPolicy: 'quarantine',
			dmarcSubdomainPolicy: 'none',
			dmarcPct: 50,
			canManage,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				DomainsDNSRecordPanel: {
					props: ['record', 'label', 'domain'],
					template:
						'<div data-testid="record">{{ record.host }} {{ record.value }} {{ domain }}</div>',
				},
			},
		},
	});
}

beforeEach(() => {
	run.mockClear();
	showToast.mockClear();
});

describe('DmarcReportingPanel', () => {
	it('names the report address and links to the dashboard', () => {
		const wrapper = mountPanel(setup());
		expect(wrapper.text()).toContain('dmarc-reports@bounces.example.com');
		expect(wrapper.find('[data-testid="dmarc-reports-link"]').attributes('href')).toBe(
			'/dashboard/admin/delivery/dmarc?domain=example.com'
		);
		expect(wrapper.find('[data-testid="dmarc-last-report"]').text()).toContain('No reports yet');
	});

	it('updates the record at the same policy when it does not ask for reports', async () => {
		const wrapper = mountPanel(setup({ isRecordRequestingReports: false }));
		await wrapper.find('[data-testid="dmarc-record-update"] button').trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith({
			domainId: 'domain_1',
			policy: 'quarantine',
			subdomainPolicy: 'none',
			pct: 50,
		});
		expect(showToast).toHaveBeenCalled();
	});

	it('shows the authorization record in the report domain zone', () => {
		const wrapper = mountPanel(
			setup({
				authorizationRecord: {
					type: 'TXT',
					hostname: 'example.com._report._dmarc.bounces.other.org',
					value: 'v=DMARC1',
				},
				reportAddress: 'dmarc-reports@bounces.other.org',
			})
		);
		expect(wrapper.find('[data-testid="record"]').text()).toBe(
			'example.com._report._dmarc.bounces.other.org v=DMARC1 bounces.other.org'
		);
	});

	it('explains the fallback when Owlat cannot read reports', () => {
		const external = mountPanel(
			setup({ mode: 'external', reportAddress: null, externalRua: 'mailto:r@elsewhere.example' })
		);
		expect(external.text()).toContain('mailto:r@elsewhere.example');
		expect(external.find('[data-testid="dmarc-reports-link"]').exists()).toBe(false);
		const none = mountPanel(setup({ mode: 'none', reportAddress: null }));
		expect(none.text()).toContain('MTA_DMARC_RUA');
	});

	it('stays hidden, without subscribing, for members who cannot manage domains', () => {
		const wrapper = mountPanel(null, false);
		expect(queryArgs).toBe('skip');
		expect(wrapper.find('[data-testid="dmarc-reporting-panel"]').exists()).toBe(false);
	});
});
