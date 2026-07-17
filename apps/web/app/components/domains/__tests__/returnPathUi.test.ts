// @vitest-environment happy-dom
/**
 * Return-path (bounce) UI — piece D3 of the DNS Setup Revamp. Real mounts.
 *
 * Two surfaces:
 *   - AddDomainForm's "Advanced" disclosure (collapsed by default) collects an
 *     optional custom return-path subdomain with a live preview, and rides it on
 *     the submit payload so the page can set it after registration.
 *   - ReturnPathEditor (the expanded-row edit affordance) changes the host via
 *     the D2 mutation, warns that it re-verifies the domain, shows the pending
 *     state, and surfaces the MTA sync-error marker when present.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, capitalize, type Ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

import AddDomainForm from '../AddDomainForm.vue';
import ReturnPathEditor from '../ReturnPathEditor.vue';
import RecordRow from '../RecordRow.vue';
import { useAddDomain, type AddDomainFlowDeps } from '~/composables/useAddDomain';

const formStubs = {
	Icon: { template: '<i />' },
	NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
};

function mountForm() {
	return mount(AddDomainForm, { global: { stubs: formStubs } });
}

describe('AddDomainForm — Advanced return-path disclosure', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, json: async () => ({}) }))
		);
	});

	it('hides the return-path section by default', () => {
		const w = mountForm();
		expect(w.find('[data-testid="advanced-section"]').exists()).toBe(false);
		expect(w.find('[data-testid="returnpath-input"]').exists()).toBe(false);
		// The toggle is present and collapsed.
		expect(w.find('[data-testid="advanced-toggle"]').attributes('aria-expanded')).toBe('false');
	});

	it('reveals the return-path input when Advanced is expanded', async () => {
		const w = mountForm();
		await w.get('[data-testid="advanced-toggle"]').trigger('click');
		expect(w.find('[data-testid="advanced-section"]').exists()).toBe(true);
		expect(w.find('[data-testid="returnpath-input"]').exists()).toBe(true);
	});

	it('previews the composed bounce host against the registrable zone', async () => {
		const w = mountForm();
		await w.get('[data-testid="domain-input"]').setValue('example.com');
		await w.get('[data-testid="advanced-toggle"]').trigger('click');
		await w.get('[data-testid="returnpath-input"]').setValue('bounce');
		const preview = w.get('[data-testid="returnpath-preview"]');
		expect(preview.text()).toContain('bounce.example.com');
		// The input is described by its preview for AT.
		expect(w.get('[data-testid="returnpath-input"]').attributes('aria-describedby')).toBe(
			w.get('[data-testid="returnpath-preview"]').attributes('id')
		);
	});

	it('frames the empty return-path state as an example, not a promise', async () => {
		const w = mountForm();
		await w.get('[data-testid="domain-input"]').setValue('example.com');
		await w.get('[data-testid="advanced-toggle"]').trigger('click');
		const preview = w.get('[data-testid="returnpath-preview"]');
		expect(preview.text()).toContain('For example');
		expect(preview.find('strong').exists()).toBe(false);
	});

	it('rejects an invalid return-path label and suppresses the preview', async () => {
		const w = mountForm();
		await w.get('[data-testid="domain-input"]').setValue('example.com');
		await w.get('[data-testid="advanced-toggle"]').trigger('click');
		await w.get('[data-testid="returnpath-input"]').setValue('not_valid');
		await w.get('[data-testid="returnpath-input"]').trigger('blur');
		expect(w.get('[data-testid="returnpath-error"]').text().toLowerCase()).toContain(
			'single label'
		);
		expect(w.find('[data-testid="returnpath-preview"]').exists()).toBe(false);
	});

	it('rides the composed return-path host on the submit payload', async () => {
		const w = mountForm();
		await w.get('[data-testid="domain-input"]').setValue('example.com');
		await w.get('[data-testid="sub-input"]').setValue('mail');
		await w.get('[data-testid="advanced-toggle"]').trigger('click');
		await w.get('[data-testid="returnpath-input"]').setValue('bounce');
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')![0]).toEqual([
			{ domain: 'mail.example.com', returnPathHost: 'bounce.example.com' },
		]);
	});

	it('emits a null return-path host when Advanced is left untouched', async () => {
		const w = mountForm();
		await w.get('[data-testid="domain-input"]').setValue('example.com');
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')![0]).toEqual([{ domain: 'mail.example.com', returnPathHost: null }]);
	});
});

// ── ReturnPathEditor (row edit affordance) ──────────────────────────────────

let mockRun: ReturnType<typeof vi.fn>;
let savingRef: Ref<boolean>;

function mountEditor(props: Record<string, unknown> = {}) {
	return mount(ReturnPathEditor, {
		props: {
			domainId: 'domain_1',
			currentHost: 'bounce.example.com',
			zone: 'example.com',
			syncError: null,
			canManage: true,
			...props,
		},
		global: { stubs: { Icon: { template: '<i />' } } },
	});
}

describe('ReturnPathEditor — edit affordance', () => {
	beforeEach(() => {
		mockRun = vi.fn(async () => null); // void mutation → null on success
		savingRef = ref(false);
		vi.stubGlobal('useBackendOperation', () => ({ run: mockRun, isLoading: savingRef }));
	});

	it('shows the current host and an Edit button, form collapsed', () => {
		const w = mountEditor();
		expect(w.text()).toContain('bounce.example.com');
		expect(w.find('[data-testid="returnpath-edit"]').exists()).toBe(true);
		expect(w.find('[data-testid="returnpath-save"]').exists()).toBe(false);
	});

	it('hides the Edit button for members who cannot manage domains', () => {
		const w = mountEditor({ canManage: false });
		expect(w.find('[data-testid="returnpath-edit"]').exists()).toBe(false);
	});

	it('warns that changing the host re-verifies the domain', async () => {
		const w = mountEditor();
		await w.get('[data-testid="returnpath-edit"]').trigger('click');
		const warning = w.get('[data-testid="returnpath-reverify-warning"]');
		expect(warning.text().toLowerCase()).toContain('re-verifies the domain');
		// Seeded from the current host relative to the zone.
		expect((w.get('#returnpath-input-domain_1').element as HTMLInputElement).value).toBe('bounce');
	});

	it('calls the D2 mutation with the composed host on save', async () => {
		const w = mountEditor();
		await w.get('[data-testid="returnpath-edit"]').trigger('click');
		await w.get('#returnpath-input-domain_1').setValue('newbounce');
		await w.get('[data-testid="returnpath-save"]').trigger('click');
		await flushPromises();
		expect(mockRun).toHaveBeenCalledWith({
			domainId: 'domain_1',
			returnPathHost: 'newbounce.example.com',
		});
		// Collapses back to the read view on success.
		expect(w.find('[data-testid="returnpath-save"]').exists()).toBe(false);
	});

	it('does not call the mutation for an invalid label', async () => {
		const w = mountEditor();
		await w.get('[data-testid="returnpath-edit"]').trigger('click');
		await w.get('#returnpath-input-domain_1').setValue('bad_label');
		await w.get('[data-testid="returnpath-save"]').trigger('click');
		await flushPromises();
		expect(mockRun).not.toHaveBeenCalled();
		expect(w.get('[data-testid="returnpath-edit-error"]').text().toLowerCase()).toContain(
			'single label'
		);
	});

	it('surfaces the pending state while the mutation is in flight', async () => {
		savingRef.value = true;
		const w = mountEditor();
		await w.get('[data-testid="returnpath-edit"]').trigger('click');
		const save = w.get('[data-testid="returnpath-save"]');
		expect(save.text()).toContain('Saving');
		expect(save.attributes('disabled')).toBeDefined();
	});

	it('renders a terminal (non-retrying) sync-error marker when the MTA reflect gave up', () => {
		const w = mountEditor({ syncError: 'permanent MTA failure' });
		const marker = w.get('[data-testid="returnpath-sync-error"]');
		expect(marker.exists()).toBe(true);
		// The D2 marker is TERMINAL (set only after the retry budget is spent), so
		// the copy is a call-to-action, not an in-progress "retrying" spinner.
		expect(marker.text().toLowerCase()).toContain("couldn't update the bounce host");
		expect(marker.text().toLowerCase()).not.toContain('retrying');
		expect(marker.find('.animate-spin').exists()).toBe(false);
	});

	it('does not render the sync-error marker when there is none', () => {
		const w = mountEditor({ syncError: null });
		expect(w.find('[data-testid="returnpath-sync-error"]').exists()).toBe(false);
	});
});

// ── C1 carry-forward: zone-framed "Configure these DNS records" heading ─────

const rowStubs = {
	Icon: { template: '<i />' },
	UiIconBox: { template: '<i />' },
	DomainsDNSRecordPanel: { template: '<div />' },
	DomainsReceivingDnsSection: { template: '<div />' },
	// Exercised above; inert here (it calls a mutation on setup).
	DomainsReturnPathEditor: { template: '<div />' },
};

function makeRowDomain(domainName: string) {
	return {
		_id: 'domain_row',
		domain: domainName,
		status: 'pending',
		createdAt: Date.now(),
		verifiedAt: null,
		lastVerifiedAt: null,
		lastRegistrationError: null,
		dmarcPolicy: 'none',
		returnPathHost: null,
		returnPathHostSyncError: null,
		dnsRecords: {
			spf: { type: 'TXT', host: '@', value: 'v=spf1 ~all' },
			dkim: [],
			dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
			mailFrom: [{ type: 'TXT', hostname: 'bounce.example.com', value: 'v=spf1 -all' }],
		},
		verificationResults: undefined,
	};
}

function mountRow(domainName: string) {
	return mount(RecordRow, {
		props: {
			domain: makeRowDomain(domainName),
			isExpanded: true,
			canForceVerify: false,
			canManageDomains: true,
			isForcing: false,
			isVerifying: false,
			isUpdatingDmarc: false,
			autoRecheckActive: false,
			spfCoexistence: null,
			dmarcPolicyOptions: [{ value: 'none', label: 'None', hint: '' }],
			showReceivingDns: false,
			inboundMailHost: null,
			inboundPort: 25,
			inboundEnabled: false,
		} as never,
		global: { stubs: rowStubs, mocks: { capitalize } },
	});
}

describe('RecordRow — zone-framed DNS config heading (C1 carry-forward)', () => {
	it('names the registrable zone, not the full sending subdomain', () => {
		const heading = mountRow('mail.example.com').get('[data-testid="config-zone"]');
		expect(heading.text()).toBe('example.com');
	});

	it('handles multi-label + co.uk zones', () => {
		expect(mountRow('a.b.example.co.uk').get('[data-testid="config-zone"]').text()).toBe(
			'example.co.uk'
		);
	});
});

// ── Page orchestration: register-then-set (useAddDomain flow) ────────────────

function makeDeps(overrides: Partial<AddDomainFlowDeps> = {}): {
	deps: AddDomainFlowDeps;
	calls: {
		createDomain: ReturnType<typeof vi.fn>;
		setReturnPathHost: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
		showToast: ReturnType<typeof vi.fn>;
		setLoading: ReturnType<typeof vi.fn>;
	};
} {
	const calls = {
		createDomain: vi.fn(async () => 'domain_new' as never),
		setReturnPathHost: vi.fn(async () => null),
		close: vi.fn(),
		showToast: vi.fn(),
		setLoading: vi.fn(),
	};
	const deps: AddDomainFlowDeps = {
		hasActiveOrganization: () => true,
		createDomain: calls.createDomain,
		setReturnPathHost: calls.setReturnPathHost,
		setLoading: calls.setLoading,
		close: calls.close,
		showToast: calls.showToast,
		...overrides,
	};
	return { deps, calls };
}

describe('useAddDomain — register-then-set orchestration', () => {
	it('registers then sets the return-path host with the returned id', async () => {
		const { deps, calls } = makeDeps();
		await useAddDomain(deps).handleAddDomain({
			domain: 'mail.example.com',
			returnPathHost: 'bounce.example.com',
		});
		expect(calls.createDomain).toHaveBeenCalledWith({ domain: 'mail.example.com' });
		expect(calls.setReturnPathHost).toHaveBeenCalledWith({
			domainId: 'domain_new',
			returnPathHost: 'bounce.example.com',
		});
		expect(calls.close).toHaveBeenCalled();
		expect(calls.showToast.mock.calls[0]![0]).toContain('added successfully');
		expect(calls.showToast.mock.calls[0]![1]).toBeUndefined(); // success (not 'error')
	});

	it('skips the return-path write when no host was supplied', async () => {
		const { deps, calls } = makeDeps();
		await useAddDomain(deps).handleAddDomain({ domain: 'example.com', returnPathHost: null });
		expect(calls.setReturnPathHost).not.toHaveBeenCalled();
		expect(calls.showToast.mock.calls[0]![0]).toContain('added successfully');
	});

	it('keeps the domain but tells the truth when the return-path set FAILS', async () => {
		// `run` resolves undefined when the operation layer caught the failure.
		const { deps, calls } = makeDeps({ setReturnPathHost: vi.fn(async () => undefined) });
		await useAddDomain(deps).handleAddDomain({
			domain: 'mail.example.com',
			returnPathHost: 'bounce.example.com',
		});
		// No rollback — the domain still exists and the modal closes.
		expect(calls.close).toHaveBeenCalled();
		const [message, type] = calls.showToast.mock.calls[0]!;
		expect(message.toLowerCase()).toContain("couldn't be set");
		expect(message.toLowerCase()).toContain("domain's row");
		expect(type).toBe('error');
	});

	it('does nothing on a create failure — no return-path write, no toast', async () => {
		const { deps, calls } = makeDeps({ createDomain: vi.fn(async () => undefined) });
		await useAddDomain(deps).handleAddDomain({
			domain: 'mail.example.com',
			returnPathHost: 'bounce.example.com',
		});
		expect(calls.setReturnPathHost).not.toHaveBeenCalled();
		expect(calls.close).not.toHaveBeenCalled();
		expect(calls.showToast).not.toHaveBeenCalled();
	});
});
