// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, watch } from 'vue';
import DeliverabilityFallbackEditor from '../DeliverabilityFallbackEditor.vue';

vi.stubGlobal('computed', computed);
vi.stubGlobal('watch', watch);

function mountEditor(relay = 'resend') {
	return mount(DeliverabilityFallbackEditor, {
		props: {
			messageType: 'campaign',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
				{ providerType: 'resend', isEnabled: true },
			],
			providerLabel: (kind: string) => kind.toUpperCase(),
			enabled: true,
			relay,
			warmupOverflow: false,
		},
	});
}

describe('DeliverabilityFallbackEditor', () => {
	it('offers only SES and synchronizes an unsupported model value', async () => {
		const wrapper = mountEditor();
		await wrapper.vm.$nextTick();

		const options = wrapper.findAll('#fallback-relay option');
		expect(options).toHaveLength(1);
		expect(options[0]!.attributes('value')).toBe('ses');
		expect(wrapper.emitted('update:relay')?.at(-1)).toEqual(['ses']);
	});
});
