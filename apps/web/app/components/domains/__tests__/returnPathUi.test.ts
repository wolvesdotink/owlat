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
import { ref, type Ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

import AddDomainForm from '../AddDomainForm.vue';
import ReturnPathEditor from '../ReturnPathEditor.vue';

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
		expect(w.find('#add-returnpath').exists()).toBe(false);
		// The toggle is present and collapsed.
		expect(w.find('[data-testid="advanced-toggle"]').attributes('aria-expanded')).toBe('false');
	});

	it('reveals the return-path input when Advanced is expanded', async () => {
		const w = mountForm();
		await w.get('[data-testid="advanced-toggle"]').trigger('click');
		expect(w.find('[data-testid="advanced-section"]').exists()).toBe(true);
		expect(w.find('#add-returnpath').exists()).toBe(true);
	});

	it('previews the composed bounce host against the registrable zone', async () => {
		const w = mountForm();
		await w.get('#add-domain-name').setValue('example.com');
		await w.get('[data-testid="advanced-toggle"]').trigger('click');
		await w.get('#add-returnpath').setValue('bounce');
		const preview = w.get('[data-testid="returnpath-preview"]');
		expect(preview.text()).toContain('bounce.example.com');
		// The input is described by its preview for AT.
		expect(w.get('#add-returnpath').attributes('aria-describedby')).toBe('add-returnpath-preview');
	});

	it('frames the empty return-path state as an example, not a promise', async () => {
		const w = mountForm();
		await w.get('#add-domain-name').setValue('example.com');
		await w.get('[data-testid="advanced-toggle"]').trigger('click');
		const preview = w.get('[data-testid="returnpath-preview"]');
		expect(preview.text()).toContain('For example');
		expect(preview.find('strong').exists()).toBe(false);
	});

	it('rejects an invalid return-path label and suppresses the preview', async () => {
		const w = mountForm();
		await w.get('#add-domain-name').setValue('example.com');
		await w.get('[data-testid="advanced-toggle"]').trigger('click');
		await w.get('#add-returnpath').setValue('not_valid');
		await w.get('#add-returnpath').trigger('blur');
		expect(w.get('#add-returnpath-error').text().toLowerCase()).toContain('single label');
		expect(w.find('[data-testid="returnpath-preview"]').exists()).toBe(false);
	});

	it('rides the composed return-path host on the submit payload', async () => {
		const w = mountForm();
		await w.get('#add-domain-name').setValue('example.com');
		await w.get('#add-domain-sub').setValue('mail');
		await w.get('[data-testid="advanced-toggle"]').trigger('click');
		await w.get('#add-returnpath').setValue('bounce');
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')![0]).toEqual([
			{ domain: 'mail.example.com', returnPathHost: 'bounce.example.com' },
		]);
	});

	it('emits a null return-path host when Advanced is left untouched', async () => {
		const w = mountForm();
		await w.get('#add-domain-name').setValue('example.com');
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

	it('renders the sync-error marker when the MTA reflect failed', () => {
		const w = mountEditor({ syncError: 'permanent MTA failure' });
		expect(w.find('[data-testid="returnpath-sync-error"]').exists()).toBe(true);
		expect(w.get('[data-testid="returnpath-sync-error"]').text().toLowerCase()).toContain(
			'sync failed'
		);
	});

	it('does not render the sync-error marker when there is none', () => {
		const w = mountEditor({ syncError: null });
		expect(w.find('[data-testid="returnpath-sync-error"]').exists()).toBe(false);
	});
});
