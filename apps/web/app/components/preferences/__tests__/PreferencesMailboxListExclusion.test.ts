// @vitest-environment happy-dom
/**
 * The hosted-decision opt-out on the admin mailbox list (ADR-0060 §9; Sol r8
 * F2). Only this list reaches every mailbox in the organization, a teammate's
 * personal one included, so an admin manages each one here; a member's list
 * has no such control (they keep the read-only line on Writing voice).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PreferencesMailboxList from '../PreferencesMailboxList.vue';
import HostedDecisionExclusion from '~/components/settings/HostedDecisionExclusion.vue';

const ORG_LIST = getFunctionName(api.mail.mailbox.identity.listOrgMailboxes);
const EXCLUSION = getFunctionName(api.decision.exclusion.setHostedDecisionExclusion);

const row = (id: string, address: string, over: Record<string, unknown> = {}) => ({
	_id: id,
	address,
	displayName: address,
	status: 'active',
	scope: 'personal',
	usedBytes: 0,
	...over,
});
const ORG = [
	row('mb_admin', 'ada@northwind.studio'),
	row('mb_mate', 'jonas@northwind.studio', { isExcludedFromHostedDecisions: true }),
];

const isAdmin = ref(true);
const exclusionRuns: unknown[] = [];

beforeEach(() => {
	isAdmin.value = true;
	exclusionRuns.length = 0;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePermissions', () => ({ isAdmin: computed(() => isAdmin.value) }));
	vi.stubGlobal('usePostboxMailbox', () => ({
		mailboxes: computed(() => [ORG[0]]),
		isLoading: ref(false),
	}));
	vi.stubGlobal('useConvexQuery', (fn: Parameters<typeof getFunctionName>[0], args: unknown) => {
		const resolved = computed(() => (typeof args === 'function' ? args() : args));
		const rows = getFunctionName(fn) === ORG_LIST ? ORG : [];
		return {
			data: computed(() => (resolved.value === 'skip' ? undefined : rows)),
			isLoading: ref(false),
		};
	});
	vi.stubGlobal('useBackendOperation', (fn: Parameters<typeof getFunctionName>[0]) => ({
		run: vi.fn(async (args: unknown) => {
			if (getFunctionName(fn) === EXCLUSION) exclusionRuns.push(args);
			return { ok: true, result: null };
		}),
		isLoading: ref(false),
	}));
	vi.stubGlobal('useInboxes', () => ({ byId: computed(() => new Map()) }));
});

function mountList() {
	return mount(PreferencesMailboxList, {
		global: {
			plugins: [createTestI18n()],
			components: { SettingsHostedDecisionExclusion: HostedDecisionExclusion },
			stubs: {
				Icon: true,
				InboxChip: true,
				NuxtLink: { template: '<a><slot /></a>' },
				UiModal: true,
				UiConfirmationDialog: true,
				UiButton: true,
				I18nT: true,
				UiSwitch: {
					props: ['modelValue', 'disabled'],
					emits: ['update:modelValue'],
					template:
						'<input type="checkbox" data-testid="switch" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
				},
			},
		},
	});
}

describe('PreferencesMailboxList hosted-decision opt-out', () => {
	it("lets an admin readmit or exclude a teammate's personal mailbox", async () => {
		const w = mountList();
		const rows = w.findAll('[data-testid="hosted-decision-exclusion-mailbox"]');
		expect(rows).toHaveLength(2);
		expect(rows[1]!.text()).toContain('jonas@northwind.studio');
		const mateSwitch = rows[1]!.get('[data-testid="switch"]');
		expect((mateSwitch.element as HTMLInputElement).checked).toBe(true);
		expect(mateSwitch.attributes('disabled')).toBeUndefined();
		await mateSwitch.setValue(false);
		await rows[0]!.get('[data-testid="switch"]').setValue(true);
		expect(exclusionRuns).toEqual([
			{ target: { kind: 'mailbox', mailboxId: 'mb_mate' }, isExcluded: false },
			{ target: { kind: 'mailbox', mailboxId: 'mb_admin' }, isExcluded: true },
		]);
	});

	it("gives a member's list no opt-out control", () => {
		isAdmin.value = false;
		const w = mountList();
		expect(w.find('[data-testid="hosted-decision-exclusion-mailbox"]').exists()).toBe(false);
	});
});
