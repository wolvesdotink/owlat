// @vitest-environment happy-dom
/**
 * The Blocklist lookups card: it names why the last check failed, saves a DQS
 * key write-only (only the hint ever comes back), and words a rejected key
 * under the field instead of pretending it was saved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const GET = getFunctionName(api.delivery.dnsblAccess.get);
const SET = getFunctionName(api.delivery.dnsblAccess.setSpamhausKey);

const stubs = {
	Icon: { template: '<i />' },
	UiIconBox: { template: '<span />' },
	UiCard: { template: '<div><slot name="header" /><slot /></div>' },
	UiInput: {
		props: ['modelValue', 'error', 'label', 'helpText'],
		emits: ['update:modelValue'],
		template:
			'<label>{{ label }}<input data-testid="key-input" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><span v-if="error" data-testid="key-error">{{ error }}</span><span>{{ helpText }}</span></label>',
	},
	UiButton: {
		props: ['disabled', 'loading', 'type'],
		emits: ['click'],
		template:
			'<button :type="type ?? \'button\'" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
	},
};

const refused = {
	status: 'ready',
	access: {
		resolver: { configured: 'bundled', lastPath: 'bundled' },
		spamhaus: {
			access: 'public',
			status: 'unknown',
			reason: 'resolver_refused',
			checkedAt: Date.now() - 60_000,
		},
	},
};

let calls: { name: string; args: unknown }[];
let results: Map<string, unknown>;
const showToast = vi.fn();

async function mountCard() {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useRoute', () => ({ hash: '' }));
	vi.stubGlobal('useBackendOperation', (operation: FunctionReference<'action'>) => {
		const name = getFunctionName(operation);
		return {
			run: vi.fn(async (args: unknown) => {
				calls.push({ name, args });
				return { ok: true, result: results.get(name) };
			}),
			isLoading: ref(false),
			inlineError: ref(null),
		};
	});
	const component = (await import('../BlocklistLookupsCard.vue')).default;
	const wrapper = mount(component, { global: { plugins: [createTestI18n()], stubs } });
	await flushPromises();
	return wrapper;
}

beforeEach(() => {
	calls = [];
	results = new Map([[GET, refused]]);
	showToast.mockClear();
});
afterEach(() => {
	vi.resetModules();
});

describe('BlocklistLookupsCard', () => {
	it('says Spamhaus refused the check, and through which path', async () => {
		const wrapper = await mountCard();

		expect(wrapper.get('[data-testid="blocklist-lookups-status"]').text()).toBe(
			'Refused by Spamhaus'
		);
		expect(wrapper.get('[data-testid="blocklist-lookups-failure"]').text()).toContain(
			"doesn't answer lookups sent through shared DNS resolvers"
		);
		expect(wrapper.get('[data-testid="blocklist-lookups-access"]').text()).toBe('Public mirror');
		expect(wrapper.text()).toContain('Built-in resolver');
		expect(wrapper.find('[data-testid="blocklist-lookups-remove"]').exists()).toBe(false);
	});

	it('saves a key write-only and shows only its hint afterwards', async () => {
		results.set(SET, {
			ok: true,
			access: {
				resolver: { configured: 'bundled' },
				spamhaus: { access: 'dqs', keyHint: 'wxyz', status: 'pending' },
			},
		});
		const wrapper = await mountCard();

		await wrapper.get('[data-testid="key-input"]').setValue('abcdefghijklmnopqrstuvwxyz');
		await wrapper.get('form').trigger('submit');
		await flushPromises();

		expect(calls.find((call) => call.name === SET)?.args).toEqual({
			key: 'abcdefghijklmnopqrstuvwxyz',
		});
		expect(wrapper.get('[data-testid="blocklist-lookups-access"]').text()).toBe(
			'Data Query Service · key ending wxyz'
		);
		expect((wrapper.get('[data-testid="key-input"]').element as HTMLInputElement).value).toBe('');
		expect(wrapper.get('[data-testid="blocklist-lookups-status"]').text()).toBe('Not checked yet');
		expect(showToast).toHaveBeenCalledWith('Key saved. Owlat is checking your sending IPs again.');
		expect(wrapper.find('[data-testid="blocklist-lookups-remove"]').exists()).toBe(true);
	});

	it('words a rejected key under the field and keeps the old state', async () => {
		results.set(SET, { ok: false, reason: 'key_rejected' });
		const wrapper = await mountCard();

		await wrapper.get('[data-testid="key-input"]').setValue('abcdefghijklmnopqrstuvwxyz');
		await wrapper.get('form').trigger('submit');
		await flushPromises();

		expect(wrapper.get('[data-testid="key-error"]').text()).toContain(
			"Spamhaus didn't accept this key"
		);
		expect(wrapper.get('[data-testid="blocklist-lookups-access"]').text()).toBe('Public mirror');
		expect(showToast).not.toHaveBeenCalled();
	});

	it('says so plainly when the MTA cannot be asked', async () => {
		results.set(GET, { status: 'unavailable' });
		const wrapper = await mountCard();

		expect(wrapper.get('[data-testid="blocklist-lookups-status"]').text()).toBe(
			'Status unavailable'
		);
		expect(wrapper.text()).toContain("couldn't reach the MTA");
		expect(wrapper.find('form').exists()).toBe(false);
	});
});
