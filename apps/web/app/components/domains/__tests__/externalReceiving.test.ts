// @vitest-environment happy-dom
/**
 * Send-only sending domains — "keep my current provider for receiving".
 *
 * The defect these tests exist for is destructive and silent: the domain setup
 * panel hands every sending domain an APEX MX record pointing at this
 * deployment, and an operator on Google Workspace who publishes it loses all
 * their incoming mail. So the assertions here are about the two things that
 * prevent it — the choice reaching the create payload, and the row showing the
 * NO-MX guidance instead of the MX guidance — plus the loud `pointsHere`
 * verdict, which is the only state that says "this already happened to you".
 *
 * Real mounts against the real English catalog, so a state that renders the
 * wrong sentence (or a missing key) fails here rather than in front of an
 * operator.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

/** The verdict `checkExternalReceivingMx` resolves to for the mount under test. */
type MxVerdict = {
	hasMx: boolean;
	hosts: string[];
	provider: 'google' | 'microsoft' | 'other' | null;
	pointsHere: boolean;
};
let mxVerdict: MxVerdict | null = null;
/** Every `run()` the mounted components made, so the switch's args are assertable. */
const backendCalls: { args: unknown }[] = [];

// `useBackendOperation` / `useToast` are Nuxt auto-imports the SFCs reference as
// bare globals, so they have to be in place before `mount()` runs `setup()`.
vi.stubGlobal('useBackendOperation', () => ({
	run: vi.fn(async (args: unknown) => {
		backendCalls.push({ args });
		return mxVerdict === null ? { ok: false } : { ok: true, result: mxVerdict };
	}),
	isLoading: ref(false),
}));
const toasts: string[] = [];
vi.stubGlobal('useToast', () => ({ showToast: (message: string) => toasts.push(message) }));

import AddDomainForm from '../AddDomainForm.vue';
import ExternalReceivingSection from '../ExternalReceivingSection.vue';
import ReceivingModeChoice from '../ReceivingModeChoice.vue';
import ReceivingModeSwitch from '../ReceivingModeSwitch.vue';
import RecordRow from '../RecordRow.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

const baseStubs = {
	Icon: { template: '<i />' },
	UiIconBox: { template: '<i />' },
	NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	UiButton: { template: '<button v-bind="$attrs"><slot /></button>' },
};

beforeEach(() => {
	mxVerdict = null;
	backendCalls.length = 0;
	toasts.length = 0;
	// The domain-field blur fires a fail-soft DoH NS lookup; keep tests offline.
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({ ok: false, json: async () => ({}) }))
	);
});

// ---------------------------------------------------------------------------
// The choice itself
// ---------------------------------------------------------------------------

describe('ReceivingModeChoice', () => {
	function mountChoice(mode: 'owlat' | 'external' = 'owlat') {
		return mount(ReceivingModeChoice, {
			props: { mode, provider: 'google' as const },
			global: { plugins: [createTestI18n()], stubs: baseStubs },
		});
	}

	it('offers Owlat receiving as the selected default and hides the provider picker', () => {
		const w = mountChoice();
		expect(w.get('[data-testid="receiving-mode-owlat"]').attributes('checked')).toBeDefined();
		expect(w.find('[data-testid="receiving-provider-picker"]').exists()).toBe(false);
	});

	it('reveals the provider picker and the never-touch-your-MX promise when external is chosen', () => {
		const w = mountChoice('external');
		expect(w.find('[data-testid="receiving-provider-picker"]').exists()).toBe(true);
		// The reassurance is the whole point of the branch: it has to say we will
		// never ask for an MX change, in words, at the moment of choosing.
		expect(w.text()).toContain('never ask you to change an MX record');
		const options = w.findAll('option').map((o) => o.text());
		expect(options).toEqual(['Google Workspace', 'Microsoft 365', 'Another provider']);
	});

	it('emits the mode and the provider rather than owning them', async () => {
		const w = mountChoice('external');
		await w.get('[data-testid="receiving-mode-owlat"]').trigger('change');
		expect(w.emitted('update:mode')![0]).toEqual(['owlat']);
		await w.get('[data-testid="receiving-provider-select"]').setValue('microsoft');
		expect(w.emitted('update:provider')![0]).toEqual(['microsoft']);
	});
});

// ---------------------------------------------------------------------------
// The choice reaching the create payload
// ---------------------------------------------------------------------------

describe('AddDomainForm — receiving mode on the submit payload', () => {
	function mountForm(props: Record<string, unknown> = {}) {
		return mount(AddDomainForm, {
			props,
			global: {
				plugins: [createTestI18n()],
				stubs: baseStubs,
				components: { DomainsReceivingModeChoice: ReceivingModeChoice },
			},
		});
	}

	it('defaults to Owlat receiving, so an untouched form behaves exactly as before', async () => {
		const w = mountForm();
		await w.get('[data-testid="domain-input"]').setValue('example.com');
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')![0]).toEqual([
			{
				domain: 'mail.example.com',
				returnPathHost: null,
				receivingMode: 'owlat',
				externalReceivingProvider: null,
			},
		]);
	});

	it('rides the external mode and the chosen provider on the payload', async () => {
		const w = mountForm();
		await w.get('[data-testid="domain-input"]').setValue('example.com');
		await w.get('[data-testid="receiving-mode-external"]').trigger('change');
		await w.get('[data-testid="receiving-provider-select"]').setValue('microsoft');
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')![0]).toEqual([
			{
				domain: 'mail.example.com',
				returnPathHost: null,
				receivingMode: 'external',
				externalReceivingProvider: 'microsoft',
			},
		]);
	});

	it('never asks the question in the tracking flow — a tracking host has no inbound mail', () => {
		const w = mountForm({ context: 'tracking' });
		expect(w.find('[data-testid="receiving-mode-choice"]').exists()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// The guidance panel
// ---------------------------------------------------------------------------

describe('ExternalReceivingSection', () => {
	/** The generated apex record as the backend actually merged it. */
	const MERGED_SPF = 'v=spf1 include:spf.owlat.test include:_spf.google.com ~all';

	async function mountSection(verdict: MxVerdict | null, props: Record<string, unknown> = {}) {
		mxVerdict = verdict;
		const w = mount(ExternalReceivingSection, {
			props: {
				domain: 'example.com',
				provider: 'google',
				spfValue: MERGED_SPF,
				returnPathHost: 'bounce.example.com',
				canManage: true,
				...props,
			},
			global: { plugins: [createTestI18n()], stubs: baseStubs },
		});
		await flushPromises();
		return w;
	}

	it('leads with "do not change your MX records", whatever DNS says', async () => {
		const w = await mountSection(null);
		expect(w.text()).toContain("Don't change your MX records.");
		expect(w.text()).toContain('Google Workspace');
		// A failed lookup is not an error state — no verdict line at all.
		expect(w.find('[data-testid="external-receiving-points-here"]').exists()).toBe(false);
		expect(w.find('[data-testid="external-receiving-confirmed"]').exists()).toBe(false);
	});

	it('shouts when the apex MX already resolves to this instance', async () => {
		const w = await mountSection({
			hasMx: true,
			hosts: ['mail.owlat.test'],
			provider: null,
			pointsHere: true,
		});
		const loud = w.get('[data-testid="external-receiving-points-here"]');
		expect(loud.text()).toContain('Incoming mail is no longer reaching your provider.');
		expect(loud.text()).toContain('mail.owlat.test');
		// It is the ERROR tone, not a neutral note — this one means mail is lost.
		expect(loud.classes()).toContain('text-error');
		// And it outranks every other verdict.
		expect(w.find('[data-testid="external-receiving-confirmed"]').exists()).toBe(false);
	});

	it('confirms calmly when DNS agrees with the configured provider', async () => {
		const w = await mountSection({
			hasMx: true,
			hosts: ['aspmx.l.google.com'],
			provider: 'google',
			pointsHere: false,
		});
		const line = w.get('[data-testid="external-receiving-confirmed"]');
		expect(line.text()).toContain('aspmx.l.google.com');
		expect(line.classes()).toContain('text-success');
	});

	it('warns when the domain has no MX at all', async () => {
		const w = await mountSection({ hasMx: false, hosts: [], provider: null, pointsHere: false });
		expect(w.get('[data-testid="external-receiving-no-mx"]').text()).toContain(
			'No MX record found'
		);
	});

	it('reports an unrecognised MX as a fact, not a failure', async () => {
		const w = await mountSection({
			hasMx: true,
			hosts: ['mx.proofpoint.test'],
			provider: null,
			pointsHere: false,
		});
		const line = w.get('[data-testid="external-receiving-elsewhere"]');
		expect(line.text()).toContain('mx.proofpoint.test');
		expect(line.classes()).toContain('text-text-secondary');
	});

	it('names the bounce subdomain, so "publish an MX" and "never touch your MX" do not read as a contradiction', async () => {
		const w = await mountSection(null);
		expect(w.get('[data-testid="external-receiving-bounces"]').text()).toContain(
			'bounce.example.com'
		);
	});

	it('says SPF is already merged only when the RECORD carries the include', async () => {
		const w = await mountSection(null);
		expect(w.find('[data-testid="external-receiving-spf-merged"]').exists()).toBe(true);
		expect(w.find('[data-testid="external-receiving-spf-add-include"]').exists()).toBe(false);
		expect(w.find('[data-testid="external-receiving-spf-manual"]').exists()).toBe(false);
	});

	it('names the exact include to add when the stored record was never merged', async () => {
		// A relay-primary domain (SES/Mandrill) switched to external after
		// registration keeps ITS apex record: the lifecycle refuses to rebuild it
		// from our include, so nothing merged. Claiming otherwise is what leaves
		// Google unauthorized for everything this customer still sends from Gmail.
		const w = await mountSection(null, { spfValue: 'v=spf1 include:amazonses.com -all' });
		const add = w.get('[data-testid="external-receiving-spf-add-include"]');
		expect(add.text()).toContain('include:_spf.google.com');
		expect(add.classes()).toContain('text-warning');
		expect(w.find('[data-testid="external-receiving-spf-merged"]').exists()).toBe(false);
	});

	it('does not point at a record above when there is none', async () => {
		const w = await mountSection(null, { spfValue: null });
		expect(w.get('[data-testid="external-receiving-spf-none"]').text()).toContain(
			'There is no SPF record yet.'
		);
		expect(w.find('[data-testid="external-receiving-spf-merged"]').exists()).toBe(false);
	});

	it('asks the operator to merge SPF themselves when the provider is unknown to us', async () => {
		const w = await mountSection(null, { provider: 'other' });
		const manual = w.get('[data-testid="external-receiving-spf-manual"]');
		expect(manual.text()).toContain('Merge the SPF record yourself.');
		expect(manual.classes()).toContain('text-warning');
	});

	it('notes a receiver that is not the provider the domain is configured for', async () => {
		// The merged SPF authorizes the DECLARED provider, so mail sent from the
		// one actually receiving is unauthorized. A note, not an error.
		const w = await mountSection({
			hasMx: true,
			hosts: ['acme.mail.protection.outlook.com'],
			provider: 'microsoft',
			pointsHere: false,
		});
		const note = w.get('[data-testid="external-receiving-provider-mismatch"]');
		expect(note.text()).toContain('Microsoft 365');
		expect(note.text()).toContain('Google Workspace');
		expect(note.classes()).not.toContain('text-error');
	});

	it('stays quiet about a mismatch when the MX is simply one we do not recognise', async () => {
		const w = await mountSection({
			hasMx: true,
			hosts: ['mx.proofpoint.test'],
			provider: null,
			pointsHere: false,
		});
		expect(w.find('[data-testid="external-receiving-provider-mismatch"]').exists()).toBe(false);
	});

	it('offers the IMAP path to actually read the mail here', async () => {
		const w = await mountSection(null);
		const link = w.findAll('a').find((a) => a.attributes('href') === '/dashboard/postbox/migrate');
		expect(link).toBeTruthy();
	});

	it('skips the admin-gated lookup entirely for a member who may not run it', async () => {
		await mountSection(
			{ hasMx: true, hosts: ['x'], provider: null, pointsHere: false },
			{
				canManage: false,
			}
		);
		expect(backendCalls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// The row branch
// ---------------------------------------------------------------------------

describe('RecordRow — receiving branch', () => {
	const rowStubs = {
		...baseStubs,
		DomainsDNSRecordPanel: { template: '<div />' },
		DomainsReceivingDnsSection: { template: '<div data-testid="owlat-receiving" />' },
		DomainsExternalReceivingSection: {
			props: ['domain', 'provider', 'spfValue', 'returnPathHost', 'canManage'],
			template: '<div data-testid="external-receiving-stub" :data-spf="spfValue" />',
		},
		DomainsReceivingModeSwitch: { template: '<div data-testid="mode-switch-stub" />' },
		DomainsReturnPathEditor: { template: '<div />' },
		DomainsStreamSubdomainPlanPanel: true,
		DomainsYahooCflPanel: true,
		DomainsDnsPropagationNote: true,
	};

	function mountRow(overrides: Record<string, unknown> = {}, isExpanded = true) {
		return mount(RecordRow, {
			props: {
				domain: {
					_id: 'domain_1',
					domain: 'mail.example.com',
					status: 'pending',
					createdAt: Date.now(),
					verifiedAt: null,
					lastVerifiedAt: null,
					lastRegistrationError: null,
					dmarcPolicy: 'none',
					dnsRecords: {
						spf: { type: 'TXT', host: '@', value: 'v=spf1 include:_spf.owlat.test ~all' },
						dkim: [],
						dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
						mailFrom: [{ type: 'TXT', hostname: 'bounce.example.com', value: 'v=spf1 -all' }],
					},
					verificationResults: undefined,
					...overrides,
				},
				isExpanded,
				canForceVerify: false,
				canManageDomains: true,
				isForcing: false,
				isVerifying: false,
				isUpdatingDmarc: false,
				autoRecheckActive: false,
				spfCoexistence: null,
				dmarcPolicyOptions: [{ value: 'none', label: 'None', hint: 'Monitor only.' }],
				showReceivingDns: true,
				inboundMailHost: 'mail.owlat.test',
				inboundPort: 25,
				inboundEnabled: true,
			},
			global: { plugins: [createTestI18n()], stubs: rowStubs },
		});
	}

	it('keeps the apex-MX guidance for a domain with no receiving mode stored', () => {
		const w = mountRow();
		expect(w.find('[data-testid="owlat-receiving"]').exists()).toBe(true);
		expect(w.find('[data-testid="external-receiving-stub"]').exists()).toBe(false);
	});

	it('REPLACES the apex-MX guidance for an external-receiving domain', () => {
		const w = mountRow({ receivingMode: 'external', externalReceivingProvider: 'google' });
		expect(w.find('[data-testid="external-receiving-stub"]').exists()).toBe(true);
		// Showing both would hand the operator the very record that breaks them.
		expect(w.find('[data-testid="owlat-receiving"]').exists()).toBe(false);
	});

	it('hands the section the STORED apex record, so its SPF claim is about that record', () => {
		const w = mountRow({ receivingMode: 'external', externalReceivingProvider: 'google' });
		expect(w.get('[data-testid="external-receiving-stub"]').attributes('data-spf')).toBe(
			'v=spf1 include:_spf.owlat.test ~all'
		);
	});

	it('renders the external guidance even with no deployment mail host to point at', () => {
		const w = mountRow({ receivingMode: 'external', externalReceivingProvider: 'google' });
		// `showReceivingDns` is what gates the Owlat arm; the external arm does not
		// depend on this deployment having an MTA at all.
		expect(w.find('[data-testid="external-receiving-stub"]').exists()).toBe(true);
	});

	it('names the provider in the COLLAPSED row, so send-only is visible without expanding', () => {
		const w = mountRow(
			{ receivingMode: 'external', externalReceivingProvider: 'microsoft' },
			false
		);
		expect(w.get('[data-testid="receiving-via-hint"]').text()).toBe('receiving via Microsoft 365');
	});

	it('shows no receiving hint for an ordinary domain', () => {
		const w = mountRow({}, false);
		expect(w.find('[data-testid="receiving-via-hint"]').exists()).toBe(false);
	});

	it('offers the mode switch to an admin', () => {
		expect(mountRow().find('[data-testid="mode-switch-stub"]').exists()).toBe(true);
	});

	it('withholds the mode switch from a member who cannot manage domains', () => {
		const w = mount(RecordRow, {
			props: {
				domain: mountRow().props('domain'),
				isExpanded: true,
				canForceVerify: false,
				canManageDomains: false,
				isForcing: false,
				isVerifying: false,
				isUpdatingDmarc: false,
				autoRecheckActive: false,
				spfCoexistence: null,
				dmarcPolicyOptions: [],
				showReceivingDns: true,
				inboundMailHost: 'mail.owlat.test',
				inboundPort: 25,
				inboundEnabled: true,
			},
			global: { plugins: [createTestI18n()], stubs: rowStubs },
		});
		expect(w.find('[data-testid="mode-switch-stub"]').exists()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Changing the answer later
// ---------------------------------------------------------------------------

describe('ReceivingModeSwitch', () => {
	const switchStubs = {
		...baseStubs,
		UiConfirmationDialog: {
			props: ['open', 'title', 'description'],
			template:
				'<div v-if="open" data-testid="confirm"><button data-testid="confirm-yes" @click="$emit(\'confirm\')" /></div>',
		},
	};

	function mountSwitch(props: Record<string, unknown> = {}) {
		return mount(ReceivingModeSwitch, {
			props: {
				domainId: 'domain_1',
				domain: 'mail.example.com',
				mode: 'owlat' as const,
				provider: null,
				...props,
			},
			global: {
				plugins: [createTestI18n()],
				stubs: switchStubs,
				components: { DomainsReceivingModeChoice: ReceivingModeChoice },
			},
		});
	}

	it('states the stored mode as a plain fact, with no editor open', () => {
		const w = mountSwitch();
		expect(w.get('[data-testid="receiving-mode-current"]').text()).toBe(
			'Owlat receives mail for this domain.'
		);
		expect(w.find('[data-testid="receiving-mode-choice"]').exists()).toBe(false);
	});

	it('names the provider when receiving already sits elsewhere', () => {
		const w = mountSwitch({ mode: 'external', provider: 'google' });
		expect(w.get('[data-testid="receiving-mode-current"]').text()).toBe(
			'Receiving stays with Google Workspace.'
		);
	});

	it('stages the change: nothing is written until the confirmation is accepted', async () => {
		const w = mountSwitch();
		await w.get('[data-testid="receiving-mode-change"]').trigger('click');
		await w.get('[data-testid="receiving-mode-external"]').trigger('change');
		// Picking a radio must not have written anything.
		expect(backendCalls).toHaveLength(0);
		// The cost of the change is stated before the click.
		expect(w.text()).toContain('drops the domain back to pending');

		await w.get('[data-testid="receiving-mode-save"]').trigger('click');
		expect(backendCalls).toHaveLength(0); // still only the confirmation
		mxVerdict = { hasMx: false, hosts: [], provider: null, pointsHere: false }; // make run() succeed
		await w.get('[data-testid="confirm-yes"]').trigger('click');
		await flushPromises();

		expect(backendCalls).toHaveLength(1);
		expect(backendCalls[0]!.args).toEqual({
			domainId: 'domain_1',
			mode: 'external',
			provider: 'google',
		});
		expect(toasts[0]).toContain('Receiving stays with your provider');
	});

	it('omits the provider when switching back to Owlat, so no stale brand is left on the row', async () => {
		const w = mountSwitch({ mode: 'external', provider: 'microsoft' });
		await w.get('[data-testid="receiving-mode-change"]').trigger('click');
		await w.get('[data-testid="receiving-mode-owlat"]').trigger('change');
		await w.get('[data-testid="receiving-mode-save"]').trigger('click');
		mxVerdict = { hasMx: false, hosts: [], provider: null, pointsHere: false };
		await w.get('[data-testid="confirm-yes"]').trigger('click');
		await flushPromises();
		expect(backendCalls[0]!.args).toEqual({ domainId: 'domain_1', mode: 'owlat' });
	});

	it('refuses to save a no-op — an unchanged draft must not drop a verified domain to pending', async () => {
		const w = mountSwitch({ mode: 'external', provider: 'google' });
		await w.get('[data-testid="receiving-mode-change"]').trigger('click');
		expect(w.get('[data-testid="receiving-mode-save"]').attributes('disabled')).toBeDefined();
	});
});
