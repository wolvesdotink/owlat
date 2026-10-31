/**
 * The integration import modal: the provider list, the configure form, and the
 * progress the backend reports, driven end to end through the step components.
 * The modal owns the state machine and the form state; the steps render it and
 * write back through `v-model` and events, so these cases cover the wiring
 * between them as well as what an operator reads.
 *
 * Mounted against the real English catalog.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, ref, type Ref } from 'vue';

import { createTestI18n } from '~/__tests__/i18n';

// The modal names its query and mutations through `api`; the stubbed client
// below never reaches Convex.
vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

import IntegrationImportModal from '../IntegrationImportModal.vue';

const i18n = createTestI18n();

let toasts: string[];
let mutation: ReturnType<typeof vi.fn>;
let progress: Ref<Record<string, unknown> | null>;
let enabledFlags: Set<string>;

const UiModalStub = defineComponent({
	props: { open: Boolean, size: String },
	emits: ['update:open'],
	setup(props, { slots, emit }) {
		return () =>
			props.open
				? h('div', { class: 'modal' }, [
						h('button', { class: 'dismiss', onClick: () => emit('update:open', false) }, 'dismiss'),
						h('div', { class: 'body' }, slots.default?.()),
						h('div', { class: 'footer' }, slots.footer?.()),
					])
				: null;
	},
});

const NuxtLinkStub = defineComponent({
	props: { to: String },
	setup(props, { slots }) {
		return () => h('a', { href: props.to }, slots.default?.());
	},
});

beforeEach(() => {
	toasts = [];
	mutation = vi.fn().mockResolvedValue(null);
	progress = ref(null);
	enabledFlags = new Set(['imports.mailchimp', 'imports.stripe', 'imports.mandrill']);

	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', () => ({ showToast: (text: string) => toasts.push(text) }));
	vi.stubGlobal('useConvex', () => ({ mutation }));
	vi.stubGlobal('useConvexQuery', () => ({ data: progress }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: (flag: string) => enabledFlags.has(flag) }));
});

// NOTE: no `vi.unstubAllGlobals()` teardown — it would also drop the Vue
// reactivity primitives app/__tests__/setup.ts installs as Nuxt auto-imports.

async function mountModal(topics: Array<{ _id: string; name: string }> = []) {
	const wrapper = mount(IntegrationImportModal, {
		props: { open: false, topics },
		global: {
			plugins: [i18n],
			stubs: {
				UiModal: UiModalStub,
				NuxtLink: NuxtLinkStub,
				Icon: true,
				I18nT: true,
				UiIconBox: true,
				UiProgressBar: true,
			},
		},
	});
	// Opening resets the form, the way the contacts page opens it.
	await wrapper.setProps({ open: true });
	return wrapper;
}

function clickButton(wrapper: ReturnType<typeof mount>, label: string) {
	const button = wrapper.findAll('button').find((b) => b.text().includes(label));
	if (!button) throw new Error(`No button labelled "${label}" in: ${wrapper.text()}`);
	return button.trigger('click');
}

const running = (over: Record<string, unknown>) => ({
	_id: 'import-1',
	status: 'running',
	provider: 'mailchimp',
	imported: 0,
	updated: 0,
	skipped: 0,
	failed: 0,
	errors: [],
	...over,
});

describe('IntegrationImportModal — choosing a provider', () => {
	it('offers only the providers whose feature flag is on', async () => {
		enabledFlags = new Set(['imports.stripe']);
		const wrapper = await mountModal();

		expect(wrapper.text()).toContain('Stripe');
		expect(wrapper.text()).not.toContain('Mailchimp');
		expect(wrapper.text()).not.toContain('Mandrill');
	});

	it('closes behind the settings link when no provider is enabled', async () => {
		enabledFlags = new Set();
		const wrapper = await mountModal();

		expect(wrapper.text()).toContain('No integrations enabled');
		await wrapper.find('a[href="/dashboard/admin/instance/features"]').trigger('click');

		expect(wrapper.emitted('update:open')).toEqual([[false]]);
	});

	it('opens the provider form and checks it before starting', async () => {
		const wrapper = await mountModal();

		await clickButton(wrapper, 'Mailchimp');
		expect(wrapper.text()).toContain('Configure Mailchimp');

		await clickButton(wrapper, 'Start import');
		expect(wrapper.text()).toContain('Mailchimp API key is required');
		expect(mutation).not.toHaveBeenCalled();

		await clickButton(wrapper, 'Back');
		expect(wrapper.text()).not.toContain('Mailchimp API key is required');
	});
});

describe('IntegrationImportModal — the configure form', () => {
	it('starts the import with what the operator entered', async () => {
		const wrapper = await mountModal([{ _id: 'topic-1', name: 'Newsletter' }]);
		await clickButton(wrapper, 'Mailchimp');

		const [apiKey, listId] = wrapper.findAll('input[type="password"], input[type="text"]');
		await apiKey!.setValue('  0123456789abcdef-us21 ');
		await listId!.setValue('a1b2c3');
		await wrapper.find('input[type="checkbox"]').setValue(false);
		await wrapper.find('input[type="radio"][value="update"]').setValue(true);
		await wrapper.find('select').setValue('topic-1');
		await clickButton(wrapper, 'Start import');
		await flushPromises();

		expect(mutation).toHaveBeenCalledTimes(1);
		expect(mutation.mock.calls[0]![1]).toEqual({
			config: {
				provider: 'mailchimp',
				apiKey: '0123456789abcdef-us21',
				listId: 'a1b2c3',
				importSuppressions: false,
			},
			handleDuplicates: 'update',
			topicId: 'topic-1',
		});
		expect(wrapper.text()).toContain('Importing from Mailchimp...');
	});

	it('starts a Mandrill run with no credentials and no contact options', async () => {
		const wrapper = await mountModal([{ _id: 'topic-1', name: 'Newsletter' }]);
		await clickButton(wrapper, 'Mandrill');

		expect(wrapper.find('select').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Handle duplicates');
		await clickButton(wrapper, 'Start import');
		await flushPromises();

		expect(mutation.mock.calls[0]![1]).toEqual({
			config: { provider: 'mandrill' },
			handleDuplicates: 'skip',
		});
	});

	it('does not carry the last form into the next opening', async () => {
		const wrapper = await mountModal();
		await clickButton(wrapper, 'Stripe');
		await wrapper.find('input[type="password"]').setValue('sk_test_123');

		await wrapper.setProps({ open: false });
		await wrapper.setProps({ open: true });
		await clickButton(wrapper, 'Stripe');

		expect((wrapper.find('input[type="password"]').element as HTMLInputElement).value).toBe('');
	});
});

describe('IntegrationImportModal — progress and completion', () => {
	async function startStripeImport() {
		const wrapper = await mountModal();
		await clickButton(wrapper, 'Stripe');
		await wrapper.find('input[type="password"]').setValue('sk_test_123');
		await clickButton(wrapper, 'Start import');
		await flushPromises();
		return wrapper;
	}

	it('reports the running count, then the totals once the backend completes', async () => {
		const wrapper = await startStripeImport();

		progress.value = running({
			provider: 'stripe',
			imported: 1200,
			updated: 34,
			totalEstimate: 5000,
		});
		await flushPromises();
		expect(wrapper.text()).toContain('Imported 1,234 of ~5,000...');

		progress.value = running({
			provider: 'stripe',
			status: 'completed',
			imported: 4900,
			updated: 60,
			skipped: 30,
			failed: 10,
			errors: ['Customer cus_1: no email'],
		});
		await flushPromises();

		const text = wrapper.text();
		expect(text).toContain('Import complete!');
		expect(text).toContain('4900');
		expect(text).toContain('Customer cus_1: no email');
		expect(toasts).toEqual(['Successfully processed 4960 contacts from Stripe']);

		await clickButton(wrapper, 'Done');
		expect(wrapper.emitted('update:open')).toEqual([[false]]);
	});

	it('returns to the form with the error when a run fails before importing anything', async () => {
		const wrapper = await startStripeImport();

		progress.value = running({
			provider: 'stripe',
			status: 'failed',
			errors: ['Invalid API key provided'],
		});
		await flushPromises();

		expect(wrapper.text()).toContain('Invalid API key provided');
		expect(wrapper.find('input[type="password"]').exists()).toBe(true);
	});

	it('shows a suppression-only summary for a Mandrill run', async () => {
		const wrapper = await mountModal();
		await clickButton(wrapper, 'Mandrill');
		await clickButton(wrapper, 'Start import');
		await flushPromises();

		progress.value = running({
			provider: 'mandrill',
			status: 'completed',
			suppressionCounts: {
				bouncedHard: 4,
				bouncedSoft: 1,
				complained: 2,
				manual: 1,
				unsubscribed: 9,
				alreadyBlocked: 3,
				alreadyUnsubscribed: 2,
				noContact: 5,
				skipped: 1,
			},
		});
		await flushPromises();

		const text = wrapper.text();
		expect(text).not.toContain('Imported');
		expect(text).toContain('Suppressed');
		expect(text).toMatch(/8\s*Suppressed/);
		expect(text).toMatch(/9\s*Unsubscribed/);
		expect(text).toMatch(/5\s*Already suppressed/);
		expect(text).toMatch(/6\s*Not applicable/);
	});
});
