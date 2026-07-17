// @vitest-environment happy-dom
/**
 * Connected-apps settings page (index.vue). listByTeam is owner/admin-gated, so
 * an editor must see the "Admins only" gate and the query must be skipped for
 * them. For admins the page lists apps, tests a connection (surfacing the
 * outcome), reveals the secret once after registration, and gates revoke/delete
 * behind explicit confirmation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref } from 'vue';

const role = ref<'owner' | 'editor'>('owner');

vi.mock('~/plugins/plugin-composition.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@example/policy-pack',
			manifest: Object.freeze({
				id: 'policy-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['send:gate', 'mail:read']),
				flag: Object.freeze({ default: false }),
			}),
		}),
	]),
}));

import ConnectedAppsPage from '../index.vue';

interface AppRow {
	_id: string;
	name: string;
	pluginId: string;
	endpointUrl: string;
	status: 'enabled' | 'disabled' | 'revoked';
	grantedCapabilities: string[];
	secretRotatedAt: number;
	createdByUserId: string;
	createdAt: number;
	updatedAt: number;
}

const apps = ref<AppRow[]>([]);
let listQueryArgs: (() => unknown) | undefined;

// One run mock per operation, keyed by the label the page passes to
// useBackendOperation, so a test can assert/steer each independently.
let runByLabel: Record<string, ReturnType<typeof vi.fn>> = {};
const showToast = vi.fn();

function seedApp(overrides: Partial<AppRow> = {}): AppRow {
	return {
		_id: 'app-1',
		name: 'Slack approvals',
		pluginId: 'policy-pack',
		endpointUrl: 'https://hooks.example.com/owlat',
		status: 'enabled',
		grantedCapabilities: ['send:gate'],
		secretRotatedAt: 1,
		createdByUserId: 'user-a',
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

beforeEach(() => {
	role.value = 'owner';
	apps.value = [];
	listQueryArgs = undefined;
	runByLabel = {};
	showToast.mockReset();

	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('usePermissions', () => ({
		isAdmin: computed(() => role.value !== 'editor'),
		showAdminGate: computed(() => role.value === 'editor'),
	}));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useCopyToClipboard', () => ({
		copy: vi.fn().mockResolvedValue(true),
		isCopied: () => false,
		reset: vi.fn(),
	}));
	vi.stubGlobal('useBackendOperation', (_fn: unknown, opts: { label: string }) => {
		const run = runByLabel[opts.label] ?? (runByLabel[opts.label] = vi.fn());
		return { run, isLoading: ref(false), inlineError: ref(null) };
	});
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: (() => unknown) | undefined) => {
		listQueryArgs = typeof args === 'function' ? args : undefined;
		return { data: apps, isLoading: ref(false), error: ref(null), refetch: vi.fn() };
	});
});

const passthroughStub = { template: '<div><slot name="header"/><slot/></div>' };
const buttonStub = {
	props: ['loading', 'disabled', 'variant', 'size'],
	emits: ['click'],
	template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot/></button>',
};
const confirmStub = {
	props: ['open', 'isLoading', 'title', 'description', 'variant'],
	emits: ['confirm', 'update:open'],
	template:
		'<div v-if="open" class="confirm-dialog"><button class="confirm-btn" @click="$emit(\'confirm\')">confirm</button></div>',
};
const registerModalStub = {
	props: ['open', 'plugins', 'isSubmitting', 'errorMessage'],
	emits: ['close', 'submit'],
	template:
		"<div v-if=\"open\" class=\"register-modal\"><button class=\"register-submit\" @click=\"$emit('submit', { pluginId: 'policy-pack', name: 'New app', endpointUrl: 'https://e.example.com', grantedCapabilities: ['send:gate'] })\">submit</button></div>",
};
const revealStub = {
	props: ['open', 'secret', 'appName', 'context'],
	template: '<div v-if="open" class="reveal">{{ secret }}</div>',
};

function mountPage() {
	return mount(ConnectedAppsPage, {
		global: {
			stubs: {
				UiQueryBoundary: passthroughStub,
				UiCard: passthroughStub,
				UiButton: buttonStub,
				UiConfirmationDialog: confirmStub,
				ConnectedAppRegisterModal: registerModalStub,
				ConnectedAppSecretReveal: revealStub,
				UiEmptyState: {
					props: ['title', 'description', 'icon'],
					template: '<div><p>{{ title }}</p><p>{{ description }}</p><slot /></div>',
				},
				UiBadge: true,
				UiIconBox: true,
				Icon: true,
			},
		},
	});
}

function clickButtonByText(wrapper: ReturnType<typeof mountPage>, text: string) {
	const btn = wrapper.findAll('button').find((b) => b.text().includes(text));
	if (!btn) throw new Error(`button "${text}" not found`);
	return btn.trigger('click');
}

describe('Connected apps — admins-only gate', () => {
	it('renders the gate and skips the query for an editor', () => {
		role.value = 'editor';
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('Admins only');
		expect(listQueryArgs?.()).toBe('skip');
		// The "Connect an app" action is not offered to a gated editor.
		expect(wrapper.findAll('button').some((b) => b.text().includes('Connect an app'))).toBe(false);
	});

	it('runs the query for an admin and shows the empty state', () => {
		const wrapper = mountPage();
		expect(wrapper.text()).not.toContain('Admins only');
		expect(listQueryArgs?.()).toEqual({});
		expect(wrapper.text()).toContain('No connected apps');
	});
});

describe('Connected apps — list', () => {
	it('lists an app with its endpoint and humanized capability', () => {
		apps.value = [seedApp()];
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('Slack approvals');
		expect(wrapper.text()).toContain('https://hooks.example.com/owlat');
		// send:gate → "Send · gate"
		expect(wrapper.text()).toContain('Send · gate');
	});
});

describe('Connected apps — connection test', () => {
	it('runs the test action and surfaces the outcome message', async () => {
		apps.value = [seedApp()];
		const wrapper = mountPage();
		runByLabel['Test connected-app connection']!.mockResolvedValue({
			outcome: 'ok',
			status: 204,
			message: 'Endpoint responded successfully (HTTP 204).',
		});
		await clickButtonByText(wrapper, 'Test connection');
		await flushPromises();
		expect(runByLabel['Test connected-app connection']).toHaveBeenCalledWith({
			connectedAppId: 'app-1',
		});
		const status = wrapper.find('[role="status"]');
		expect(status.exists()).toBe(true);
		expect(status.text()).toContain('Endpoint responded successfully');
	});
});

describe('Connected apps — register + one-time secret reveal', () => {
	it('registers via the wizard and reveals the secret once', async () => {
		const wrapper = mountPage();
		// Mutate the mock the component captured at setup (do not reassign the slot).
		runByLabel['Register connected app']!.mockResolvedValue({
			_id: 'app-2',
			name: 'New app',
			secret: 'cah_the-only-time-you-see-this',
		});
		await clickButtonByText(wrapper, 'Connect an app');
		await wrapper.find('.register-submit').trigger('click');
		await flushPromises();
		expect(runByLabel['Register connected app']).toHaveBeenCalledWith({
			pluginId: 'policy-pack',
			name: 'New app',
			endpointUrl: 'https://e.example.com',
			grantedCapabilities: ['send:gate'],
		});
		const reveal = wrapper.find('.reveal');
		expect(reveal.exists()).toBe(true);
		expect(reveal.text()).toContain('cah_the-only-time-you-see-this');
	});
});

describe('Connected apps — destructive flows require confirmation', () => {
	it('does not revoke until the confirmation is confirmed', async () => {
		apps.value = [seedApp()];
		const wrapper = mountPage();

		// No confirmation dialog is open yet, so the mutation has not run.
		expect(wrapper.find('.confirm-dialog').exists()).toBe(false);

		await clickButtonByText(wrapper, 'Revoke');
		// Opening the dialog alone does not call the mutation.
		expect(runByLabel['Revoke connected app']).not.toHaveBeenCalled();
		expect(wrapper.find('.confirm-dialog').exists()).toBe(true);

		await wrapper.find('.confirm-btn').trigger('click');
		await flushPromises();
		expect(runByLabel['Revoke connected app']).toHaveBeenCalledWith({ connectedAppId: 'app-1' });
	});

	it('deletes only after confirmation', async () => {
		apps.value = [seedApp({ status: 'revoked' })];
		const wrapper = mountPage();
		await clickButtonByText(wrapper, 'Delete');
		expect(runByLabel['Delete connected app']).not.toHaveBeenCalled();
		await wrapper.find('.confirm-btn').trigger('click');
		await flushPromises();
		expect(runByLabel['Delete connected app']).toHaveBeenCalledWith({ connectedAppId: 'app-1' });
	});
});
