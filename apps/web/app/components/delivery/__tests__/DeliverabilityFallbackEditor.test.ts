// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, watch } from 'vue';
import DeliverabilityFallbackEditor from '../DeliverabilityFallbackEditor.vue';

vi.stubGlobal('computed', computed);
vi.stubGlobal('watch', watch);

interface ProviderEntry {
	providerType: string;
	isEnabled: boolean;
}

const DEFAULT_PROVIDERS: ProviderEntry[] = [
	{ providerType: 'mta', isEnabled: true },
	{ providerType: 'ses', isEnabled: true },
	{ providerType: 'resend', isEnabled: true },
	{ providerType: 'mandrill', isEnabled: true },
];

function mountEditor(relay = 'resend', providers: ProviderEntry[] = DEFAULT_PROVIDERS) {
	return mount(DeliverabilityFallbackEditor, {
		props: {
			messageType: 'campaign',
			providers,
			providerLabel: (kind: string) => kind.toUpperCase(),
			enabled: true,
			relay,
			warmupOverflow: false,
		},
	});
}

function optionValues(wrapper: ReturnType<typeof mountEditor>): string[] {
	return wrapper
		.findAll('#fallback-relay option')
		.map((option) => option.attributes('value') ?? '');
}

describe('DeliverabilityFallbackEditor relay eligibility', () => {
	it('offers every enabled non-MTA transport, not just SES', async () => {
		const wrapper = mountEditor();
		await wrapper.vm.$nextTick();

		// The capability the backend actually gates on (plan D6): configured, and
		// not the arm the fallback moves traffic away from.
		expect(optionValues(wrapper)).toEqual(['ses', 'resend', 'mandrill']);
	});

	it('never offers the owned MTA — it is what the escape hatch escapes from', async () => {
		const wrapper = mountEditor('mta');
		await wrapper.vm.$nextTick();

		expect(optionValues(wrapper)).not.toContain('mta');
		expect(wrapper.emitted('update:relay')?.at(-1)).toEqual(['ses']);
	});

	it('keeps a Mandrill-only migration route on Mandrill', async () => {
		const wrapper = mountEditor('mandrill', [
			{ providerType: 'mta', isEnabled: true },
			{ providerType: 'ses', isEnabled: false },
			{ providerType: 'mandrill', isEnabled: true },
		]);
		await wrapper.vm.$nextTick();

		expect(optionValues(wrapper)).toEqual(['mandrill']);
		// Already valid, so the sync watcher must not rewrite the operator's choice.
		expect(wrapper.emitted('update:relay')).toBeUndefined();
	});

	it('says what to do when no relay is enabled instead of showing an empty select', async () => {
		const wrapper = mountEditor('', [{ providerType: 'mta', isEnabled: true }]);
		await wrapper.vm.$nextTick();

		expect(optionValues(wrapper)).toEqual([]);
		expect(wrapper.text()).toContain('Enable a relay above first');
	});

	it('does not universally tell manual-SPF operators to replace their policy', () => {
		const text = mountEditor('ses').text();
		expect(text).toContain('when one is shown');
		expect(text).toContain('preserve the reviewed manual primary SPF');
		expect(text).not.toContain('Publish the single merged apex SPF shown');
	});
});
