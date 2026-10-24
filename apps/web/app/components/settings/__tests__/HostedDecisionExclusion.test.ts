/**
 * The hosted-decision opt-out: an admin turns it on or off for
 * the Team Inbox or one mailbox, and the line says excluded mail is judged
 * only by the local engine; a member sees the state, disabled, and who can
 * change it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: { decision: { exclusion: { setHostedDecisionExclusion: 'setHostedDecisionExclusion' } } },
}));

const HostedDecisionExclusion = (await import('../HostedDecisionExclusion.vue')).default;

const run = vi.fn(async () => ({ ok: true, result: null }));
const role = ref<'admin' | 'member'>('admin');

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
	vi.stubGlobal('usePermissions', () => ({ isAdmin: computed(() => role.value === 'admin') }));
});

beforeEach(() => {
	run.mockClear();
	role.value = 'admin';
});

const SwitchStub = {
	props: ['modelValue', 'label', 'disabled'],
	emits: ['update:modelValue'],
	template:
		'<input type="checkbox" data-testid="switch" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
};

const mountToggle = (props: Record<string, unknown>) =>
	mount(HostedDecisionExclusion, {
		props,
		global: { plugins: [createTestI18n()], stubs: { UiSwitch: SwitchStub } },
	});

describe('HostedDecisionExclusion', () => {
	it('lets an admin exclude the Team Inbox, and says what that means', async () => {
		const w = mountToggle({ target: { kind: 'team_inbox' }, isExcluded: false });
		expect(w.text()).toContain('Keep out of hosted decision providers');
		expect(w.text()).toContain('judged only by the local decision engine');
		await w.get('[data-testid="switch"]').setValue(true);
		expect(run).toHaveBeenCalledWith({ target: { kind: 'team_inbox' }, isExcluded: true });
		expectFullyLocalized(w);
	});

	it('readmits a mailbox and names it', async () => {
		const target = { kind: 'mailbox', mailboxId: 'mb_1' };
		const w = mountToggle({ target, isExcluded: true, address: 'ada@northwind.studio' });
		expect(w.text()).toContain('Mail in ada@northwind.studio is then judged only by');
		await w.get('[data-testid="switch"]').setValue(false);
		expect(run).toHaveBeenCalledWith({ target, isExcluded: false });
	});

	it('shows a member the state, disabled, and who can change it', async () => {
		role.value = 'member';
		const w = mountToggle({ target: { kind: 'team_inbox' }, isExcluded: true });
		const control = w.get('[data-testid="switch"]');
		expect(control.attributes('disabled')).toBeDefined();
		expect((control.element as HTMLInputElement).checked).toBe(true);
		expect(w.text()).toContain('Only an admin can change this.');
		await control.trigger('change');
		expect(run).not.toHaveBeenCalled();
	});

	it('marks an exclusion as changed from the default, and Reset readmits', async () => {
		expect(
			mountToggle({ target: { kind: 'team_inbox' }, isExcluded: false })
				.find('[data-testid="setting-reset"]')
				.exists()
		).toBe(false);
		const w = mountToggle({ target: { kind: 'team_inbox' }, isExcluded: true });
		await w.get('[data-testid="setting-reset"] button').trigger('click');
		expect(run).toHaveBeenCalledWith({ target: { kind: 'team_inbox' }, isExcluded: false });
	});

	it('keeps the reset as locked as the switch for a member', () => {
		role.value = 'member';
		const w = mountToggle({ target: { kind: 'team_inbox' }, isExcluded: true });
		expect(w.get('[data-testid="setting-reset"] button').attributes('disabled')).toBeDefined();
	});
});
