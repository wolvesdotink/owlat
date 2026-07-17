// @vitest-environment happy-dom
/**
 * Connected-app registration wizard. Progressive disclosure gates capabilities
 * behind valid details; the risk disclosure is always shown before granting;
 * least-privilege requires at least one capability; and the emitted payload
 * carries exactly the operator's choices.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ConnectedAppRegisterModal from '../ConnectedAppRegisterModal.vue';

const ONE_PLUGIN = [{ pluginId: 'policy-pack', capabilities: ['send:gate', 'mail:read'] }];

const modalStub = {
	props: ['open', 'title', 'size', 'closable', 'persistent'],
	emits: ['update:open'],
	template: '<div v-if="open"><slot /><div class="footer"><slot name="footer" /></div></div>',
};
const buttonStub = {
	props: ['loading', 'disabled', 'variant'],
	emits: ['click'],
	template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
};
const emptyStub = { props: ['title', 'description', 'icon'], template: '<div class="empty">{{ title }}</div>' };

beforeEach(() => {
	vi.stubGlobal('useHead', vi.fn());
});

function mountModal(props: Record<string, unknown> = {}) {
	return mount(ConnectedAppRegisterModal, {
		props: {
			open: false,
			plugins: ONE_PLUGIN,
			isSubmitting: false,
			errorMessage: null,
			...props,
		},
		global: {
			stubs: { UiModal: modalStub, UiButton: buttonStub, UiEmptyState: emptyStub, Icon: true },
		},
	});
}

function clickButtonByText(wrapper: ReturnType<typeof mountModal>, text: string) {
	const btn = wrapper.findAll('button').find((b) => b.text().includes(text));
	if (!btn) throw new Error(`button "${text}" not found`);
	return btn.trigger('click');
}

async function openAt(props: Record<string, unknown> = {}) {
	const wrapper = mountModal(props);
	// The reset/preselect watcher runs on the open transition, not immediately.
	await wrapper.setProps({ open: true });
	return wrapper;
}

describe('ConnectedAppRegisterModal', () => {
	it('shows the empty state when no plugin is available to bind to', async () => {
		const wrapper = await openAt({ plugins: [] });
		expect(wrapper.text()).toContain('No plugins to connect');
	});

	it('preselects the only plugin and starts on the details step', async () => {
		const wrapper = await openAt();
		// Single plugin ⇒ no plugin <select> is rendered.
		expect(wrapper.find('select').exists()).toBe(false);
		expect(wrapper.find('#connected-app-name').exists()).toBe(true);
		expect(wrapper.find('#connected-app-endpoint').exists()).toBe(true);
		// Capabilities are not disclosed yet.
		expect(wrapper.text()).not.toContain('Capabilities to grant');
	});

	it('blocks Continue on an empty name and on a non-https endpoint', async () => {
		const wrapper = await openAt();
		await clickButtonByText(wrapper, 'Continue');
		expect(wrapper.text()).toContain('Give the connected app a name');

		await wrapper.find('#connected-app-name').setValue('My app');
		await wrapper.find('#connected-app-endpoint').setValue('http://insecure.example.com');
		await clickButtonByText(wrapper, 'Continue');
		expect(wrapper.text()).toContain('valid HTTPS endpoint');
		// Still on details — capabilities never disclosed.
		expect(wrapper.text()).not.toContain('Capabilities to grant');
	});

	it('discloses capabilities and the risk notice once details are valid', async () => {
		const wrapper = await openAt();
		await wrapper.find('#connected-app-name').setValue('My app');
		await wrapper.find('#connected-app-endpoint').setValue('https://hooks.example.com/owlat');
		await clickButtonByText(wrapper, 'Continue');
		expect(wrapper.text()).toContain('Capabilities to grant');
		// Fixed Tier-2 risk disclosure.
		expect(wrapper.text()).toContain('can never');
		expect(wrapper.text()).toContain('add work or caution');
		// Both of the plugin's capabilities are offered.
		expect(wrapper.text()).toContain('Send · gate');
		expect(wrapper.text()).toContain('Mail · read');
	});

	it('requires at least one capability before it will submit', async () => {
		const wrapper = await openAt();
		await wrapper.find('#connected-app-name').setValue('My app');
		await wrapper.find('#connected-app-endpoint').setValue('https://hooks.example.com/owlat');
		await clickButtonByText(wrapper, 'Continue');

		// Submitting with nothing selected emits nothing (least privilege).
		await clickButtonByText(wrapper, 'Register app');
		expect(wrapper.emitted('submit')).toBeUndefined();
	});

	it('emits the exact selected subset on submit', async () => {
		const wrapper = await openAt();
		await wrapper.find('#connected-app-name').setValue('My app');
		await wrapper.find('#connected-app-endpoint').setValue('https://hooks.example.com/owlat');
		await clickButtonByText(wrapper, 'Continue');

		// Grant only send:gate, not mail:read.
		const boxes = wrapper.findAll('input[type="checkbox"]');
		const sendGate = boxes.find((b) => (b.element as HTMLInputElement).value === 'send:gate');
		await sendGate!.setValue(true);

		await clickButtonByText(wrapper, 'Register app');
		const emitted = wrapper.emitted('submit');
		expect(emitted).toHaveLength(1);
		expect(emitted![0]![0]).toEqual({
			pluginId: 'policy-pack',
			name: 'My app',
			endpointUrl: 'https://hooks.example.com/owlat',
			grantedCapabilities: ['send:gate'],
		});
	});

	it('drops capabilities that the reselected plugin no longer offers', async () => {
		const twoPlugins = [
			{ pluginId: 'policy-pack', capabilities: ['send:gate', 'mail:read'] },
			{ pluginId: 'other', capabilities: ['mail:read'] },
		];
		const wrapper = await openAt({ plugins: twoPlugins });
		// Two plugins ⇒ a select is shown; none preselected.
		const select = wrapper.find('select');
		expect(select.exists()).toBe(true);
		await select.setValue('policy-pack');
		await wrapper.find('#connected-app-name').setValue('My app');
		await wrapper.find('#connected-app-endpoint').setValue('https://hooks.example.com/owlat');
		await clickButtonByText(wrapper, 'Continue');
		const sendGate = wrapper
			.findAll('input[type="checkbox"]')
			.find((b) => (b.element as HTMLInputElement).value === 'send:gate');
		await sendGate!.setValue(true);
		// Go back and switch to a plugin without send:gate.
		await clickButtonByText(wrapper, 'Back');
		await wrapper.find('select').setValue('other');
		await clickButtonByText(wrapper, 'Continue');
		const boxes = wrapper.findAll('input[type="checkbox"]');
		// Only mail:read remains available; nothing pre-checked from the prior plugin.
		expect(boxes).toHaveLength(1);
		await clickButtonByText(wrapper, 'Register app');
		// send:gate was dropped, so submit is blocked (no capability selected).
		expect(wrapper.emitted('submit')).toBeUndefined();
	});
});
