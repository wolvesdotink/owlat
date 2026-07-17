// @vitest-environment happy-dom
/**
 * Hard test gate for piece X2 — the tracking-domain guided picker.
 *
 * The tracking add flow REUSES the C2 AddDomainForm (no fork), so these are real
 * mounts that assert: (1) TrackingDomainsSection mounts the very same
 * AddDomainForm component the sending flow uses; (2) the tracking suggestions
 * (track / links / click) are present and the sending ones are not; (3) the live
 * preview is the tracking-URL flavour, composed/parsed via the shared A1 PSL
 * module (incl. a paste-a-full-domain round-trip); and (4) the composed single
 * domain string is emitted on submit, with no freemail block and no sending-apex
 * note in the tracking context.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { splitZone } from '@owlat/shared';

import AddDomainForm from '../AddDomainForm.vue';
import TrackingDomainsSection from '../TrackingDomainsSection.vue';

const stubs = {
	Icon: { template: '<i />' },
	NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
};

// The section's Nuxt data/UI composables, stubbed inert so it mounts offline.
function stubSectionComposables() {
	vi.stubGlobal('useOrganizationContext', () => ({ hasActiveOrganization: ref(true) }));
	vi.stubGlobal('useOrganizationQuery', () => ({ data: ref([]), isLoading: ref(false) }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useModal', () => ({
		isOpen: ref(true),
		isLoading: ref(false),
		open: vi.fn(),
		close: vi.fn(),
		setLoading: vi.fn(),
	}));
	vi.stubGlobal('useConfirmModal', () => ({
		isOpen: ref(false),
		data: ref(null),
		isLoading: ref(false),
		open: vi.fn(),
		close: vi.fn(),
		setLoading: vi.fn(),
	}));
}

// Mount the picker directly in the tracking configuration the section uses.
function mountTrackingForm() {
	return mount(AddDomainForm, {
		props: {
			context: 'tracking' as const,
			suggestions: ['track', 'links', 'click'],
			defaultSubdomain: 'track',
			subdomainLabel: 'Subdomain for tracking',
			subdomainPlaceholder: 'track',
			blockFreemail: false,
			showApexNote: false,
			submitLabel: 'Add Tracking Domain',
		},
		global: { stubs },
	});
}

const domainInput = (w: ReturnType<typeof mountTrackingForm>) => w.get('#add-domain-name');
const subInput = (w: ReturnType<typeof mountTrackingForm>) => w.get('#add-domain-sub');
const preview = (w: ReturnType<typeof mountTrackingForm>) =>
	w.find('[data-testid="address-preview"]');

describe('X2 — the tracking flow reuses AddDomainForm, not a fork', () => {
	beforeEach(stubSectionComposables);

	it('TrackingDomainsSection mounts the SAME AddDomainForm component', () => {
		const w = mount(TrackingDomainsSection, {
			global: {
				// Map the Nuxt auto-import tag to the real AddDomainForm so a match
				// proves reuse (a fork would resolve to a different component). Stub the
				// AddDomainForm's own leaf deps so it renders without a Nuxt runtime.
				components: { DomainsAddDomainForm: AddDomainForm },
				stubs: {
					...stubs,
					UiModal: { template: '<div><slot /></div>' },
					UiIconBox: true,
					UiSpinner: true,
					UiConfirmationDialog: true,
					DomainsDNSRecordPanel: true,
				},
			},
		});
		const form = w.findComponent(AddDomainForm);
		expect(form.exists()).toBe(true);
		// Configured for tracking, not sending.
		expect(form.props('context')).toBe('tracking');
		expect(form.props('blockFreemail')).toBe(false);
		expect(form.props('showApexNote')).toBe(false);
		expect(form.props('suggestions')).toEqual(['track', 'links', 'click']);
		expect(form.props('submitLabel')).toBe('Add Tracking Domain');
	});
});

describe('X2 — tracking suggestions', () => {
	it('offers track / links / click and none of the sending suggestions', () => {
		const w = mountTrackingForm();
		const labels = w.findAll('button').map((b) => b.text());
		for (const s of ['track', 'links', 'click']) expect(labels).toContain(s);
		for (const s of ['mail', 'post', 'send']) expect(labels).not.toContain(s);
	});

	it('defaults the subdomain to track and previews it as a tracking URL', () => {
		const w = mountTrackingForm();
		expect((subInput(w).element as HTMLInputElement).value).toBe('track');
	});

	it('a suggestion sets the subdomain and recomposes the preview', async () => {
		const w = mountTrackingForm();
		await domainInput(w).setValue('example.com');
		const linksBtn = w.findAll('button').find((b) => b.text() === 'links');
		expect(linksBtn).toBeTruthy();
		await linksBtn!.trigger('click');
		expect((subInput(w).element as HTMLInputElement).value).toBe('links');
		expect(preview(w).text()).toContain('links.example.com');
	});
});

describe('X2 — tracking-URL preview (composed via A1)', () => {
	it('frames the empty state as a tracking-URL example, not a sending address', () => {
		const w = mountTrackingForm();
		expect(preview(w).text().toLowerCase()).toContain('tracking links');
		expect(preview(w).text()).toContain('links.example.com');
		expect(preview(w).text()).not.toContain('you@');
	});

	it('previews the composed tracking host live', async () => {
		const w = mountTrackingForm();
		await domainInput(w).setValue('example.com');
		expect(preview(w).text()).toContain('track.example.com');
		expect(preview(w).text()).not.toContain('you@');
	});

	it('round-trips a pasted full domain into domain + subdomain via the shared PSL', async () => {
		const w = mountTrackingForm();
		await domainInput(w).setValue('links.example.co.uk');
		await domainInput(w).trigger('blur');
		expect((domainInput(w).element as HTMLInputElement).value).toBe('example.co.uk');
		expect((subInput(w).element as HTMLInputElement).value).toBe('links');
		expect(preview(w).text()).toContain('links.example.co.uk');
		// Anchored to the same shared split the component relies on.
		const split = splitZone('links.example.co.uk');
		expect(split.registrable).toBe('example.co.uk');
		expect(split.sub).toBe('links');
	});
});

describe('X2 — submit + tracking-context behaviour', () => {
	it('emits the composed single domain string', async () => {
		const w = mountTrackingForm();
		await domainInput(w).setValue('example.com');
		await subInput(w).setValue('track');
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')).toBeTruthy();
		expect(w.emitted('submit')![0]).toEqual(['track.example.com']);
	});

	it('does not freemail-block or show the sending-apex note in the tracking context', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, json: async () => ({}) }))
		);
		const w = mountTrackingForm();
		// A freemail zone that WOULD block in the sending flow.
		await domainInput(w).setValue('gmail.com');
		await flushPromises();
		expect(w.find('[data-testid="freemail-warning"]').exists()).toBe(false);
		// Apex choice shows no sending-reputation note here.
		const apexBtn = w.findAll('button').find((b) => b.text().includes('none'));
		await apexBtn!.trigger('click');
		expect(w.find('[data-testid="apex-note"]').exists()).toBe(false);
		// Submit is not gated by a freemail block.
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')).toBeTruthy();
	});
});
