/**
 * The operator console, end to end through its tabs and its three modals. The
 * page owns the reads and the writes; these cases drive each tab and assert on
 * what the page sends and what it tells the operator.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { formatRelativeTime } from '~/utils/formatters';
import {
	abuseStatusVariant,
	auditActionLabel,
	isBlockingAbuseStatus,
	riskLevelVariant,
	scanLevelVariant,
} from '~/utils/operatorConsole';
import UiTabs from '@owlat/ui/components/ui/Tabs.vue';
import OperatorPage from '../index.vue';

const NOW = Date.parse('2026-08-21T09:12:00Z');
const q = api.platformAdmin.queries;

const READS: Record<string, unknown> = {
	[getFunctionName(q.getPlatformStats)]: {
		abuseStatus: 'warned',
		sending: { totalSent: 128_400, bounceRate: 0.0058, complaintRate: 0.0003 },
	},
	[getFunctionName(q.listRecentAbuse)]: {
		flaggedScans: [{ resourceType: 'campaign', resourceId: 'c1', score: 72, level: 'suspicious' }],
		pendingReview: [{ id: 'c1', name: 'Late summer sale', updatedAt: NOW }],
	},
	[getFunctionName(q.getContentReviewQueue)]: {
		pending: [
			{
				type: 'campaign',
				id: 'c1',
				name: 'Late summer sale',
				subject: 'Last call',
				scan: { score: 72, level: 'suspicious' },
				updatedAt: NOW,
			},
			{ type: 'transactional', id: 't1', name: 'Password reset', subject: null, scan: null },
		],
		pendingCount: 2,
		recentlyReviewed: [{ action: 'platform_admin.content_approved', createdAt: NOW }],
	},
	[getFunctionName(q.listFlaggedOrganizations)]: [
		{
			abuseStatus: 'warned',
			riskLevel: 'high',
			bounceRate: 0.061,
			complaintRate: 0.002,
			totalSent: 18_200,
		},
	],
	[getFunctionName(q.listAllOrganizations)]: [
		{ abuseStatus: 'clean', riskLevel: 'low', defaultFromName: 'Northwind', contactCount: 4820 },
		{
			abuseStatus: 'warned',
			riskLevel: 'high',
			defaultFromEmail: 'news@harbor.example',
			contactCount: 12,
		},
	],
	[getFunctionName(q.getOrganizationDetail)]: {
		settings: { abuseStatus: 'warned', abuseStatusReason: 'High bounce rate' },
	},
	[getFunctionName(q.listPlatformAdmins)]: [
		{
			id: 'pa_1',
			authUserId: 'user_ada',
			email: 'ada@owlat.example',
			role: 'superadmin',
			createdAt: NOW,
		},
		{
			id: 'pa_2',
			authUserId: 'user_lin',
			email: 'lin@owlat.example',
			role: 'admin',
			createdAt: NOW,
		},
	],
	[getFunctionName(q.listAllUsers)]: [
		{ authUserId: 'user_ada', email: 'ada@owlat.example', name: 'Ada' },
		{ authUserId: 'user_lin', email: 'lin@owlat.example', name: 'Lin' },
		{ authUserId: 'user_kim', email: 'kim@owlat.example', name: 'Kim' },
	],
};

const ops: Record<string, ReturnType<typeof vi.fn>> = {};
const showToast = vi.fn();

const ModalStub = defineComponent({
	props: { open: { type: Boolean, default: false }, title: { type: String, default: '' } },
	emits: ['update:open'],
	template:
		'<section v-if="open" role="dialog" :aria-label="title"><slot /><footer><slot name="footer" /></footer></section>',
});
const FieldStub = (tag: 'textarea' | 'select') =>
	defineComponent({
		props: {
			modelValue: { type: String, default: '' },
			options: { type: Array, default: () => [] },
		},
		emits: ['update:modelValue'],
		template:
			tag === 'textarea'
				? '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
				: '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>',
	});

beforeEach(() => {
	for (const key of Object.keys(ops)) delete ops[key];
	showToast.mockClear();
	installNuxtStubs({
		...i18nStubs,
		useToast: () => ({ showToast }),
		useConvexQuery: (fn: Parameters<typeof getFunctionName>[0]) =>
			queryResult(READS[getFunctionName(fn)]),
		useBackendOperation: (_fn: unknown, options: { label: () => string }) => {
			const run = vi.fn(async () => ({ ok: true, result: undefined }));
			ops[options.label()] = run;
			return { run, isLoading: ref(false) };
		},
	});
});

async function mountOn(tab: string) {
	const wrapper = mount(OperatorPage, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: { UiTabs },
			// Template auto-imports; the test build does not rewrite templates.
			mocks: {
				abuseStatusVariant,
				auditActionLabel,
				isBlockingAbuseStatus,
				riskLevelVariant,
				scanLevelVariant,
				formatRelativeTime,
			},
			stubs: {
				Icon: true,
				UiBadge: { template: '<span class="badge"><slot /></span>' },
				UiButton: { template: '<button v-bind="$attrs"><slot /></button>', inheritAttrs: false },
				UiTooltip: { template: '<span><slot /></span>' },
				UiEmptyState: { props: ['title'], template: '<p>{{ title }}</p>' },
				UiQueryBoundary: true,
				UiModal: ModalStub,
				UiTextarea: FieldStub('textarea'),
				UiSelect: FieldStub('select'),
			},
		},
	});
	await flushPromises();
	const target = wrapper.findAll('[role="tab"]').find((t) => t.text().startsWith(tab))!;
	await target.trigger('click');
	await flushPromises();
	return wrapper;
}

const button = (wrapper: Awaited<ReturnType<typeof mountOn>>, label: string) =>
	wrapper.findAll('button').filter((b) => b.text().trim() === label);

describe('operator console', () => {
	it('shows the delivery tiles and the abuse signals on the overview', async () => {
		const wrapper = await mountOn('Overview');
		const text = wrapper.text();
		expect(text).toContain('Total sent (30d)');
		expect(text).toContain('128,400');
		expect(text).toContain('0.58%');
		expect(text).toContain('Pending review (1)');
		expect(text).toContain('Late summer sale');
		expect(text).toContain('campaign · score 72');
		wrapper.unmount();
	});

	it('approves a held campaign and rejects only with a reason', async () => {
		const wrapper = await mountOn('Content review');
		expect(wrapper.text()).toContain('Last call');
		expect(wrapper.text()).toContain('Recently reviewed');

		await button(wrapper, 'Approve')[0]!.trigger('click');
		await flushPromises();
		expect(ops['Approve campaign']).toHaveBeenCalledWith({ campaignId: 'c1' });
		expect(showToast).toHaveBeenLastCalledWith(
			'Approved "Late summer sale". It is back in draft for sending.'
		);

		await button(wrapper, 'Reject')[1]!.trigger('click');
		const modal = wrapper.get('[role="dialog"][aria-label="Reject content"]');
		expect(modal.text()).toContain('Rejecting returns "Password reset" to draft.');
		await button(wrapper, 'Reject').at(-1)!.trigger('click');
		expect(showToast).toHaveBeenLastCalledWith('A rejection reason is required.', 'error');
		expect(ops['Reject content']).not.toHaveBeenCalled();

		await modal.get('textarea').setValue('  Phishing link  ');
		await button(wrapper, 'Reject').at(-1)!.trigger('click');
		await flushPromises();
		expect(ops['Reject content']).toHaveBeenCalledWith({
			resourceType: 'transactional',
			resourceId: 't1',
			reason: 'Phishing link',
		});
		expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('shows the sending status and suspends with a reason', async () => {
		const wrapper = await mountOn('Workspaces');
		const text = wrapper.text();
		expect(text).toContain('Flagged — sending still allowed.');
		expect(text).toContain('Reason: High bounce rate');
		expect(text).toContain('risk: high');
		expect(text).toContain('news@harbor.example');
		expect(text).toContain('4,820');

		await button(wrapper, 'Suspend sending')[0]!.trigger('click');
		const modal = wrapper.get('[role="dialog"][aria-label="Set sending status"]');
		expect((modal.get('select').element as HTMLSelectElement).value).toBe('suspended');
		await button(wrapper, 'Apply')[0]!.trigger('click');
		expect(showToast).toHaveBeenLastCalledWith('A reason is required.', 'error');

		await modal.get('textarea').setValue('Spam complaints');
		await button(wrapper, 'Apply')[0]!.trigger('click');
		await flushPromises();
		expect(ops['Set workspace status']).toHaveBeenCalledWith({
			abuseStatus: 'suspended',
			reason: 'Spam complaints',
		});
		expect(showToast).toHaveBeenLastCalledWith('Workspace status set to "suspended".');
		wrapper.unmount();
	});

	it('removes an admin and promotes a user who is not one yet', async () => {
		const wrapper = await mountOn('Admins');
		expect(wrapper.text()).toContain('lin@owlat.example');

		await button(wrapper, 'Remove')[1]!.trigger('click');
		await flushPromises();
		expect(ops['Remove platform admin']).toHaveBeenCalledWith({ adminId: 'pa_2' });
		expect(showToast).toHaveBeenLastCalledWith('Removed lin@owlat.example from platform admins.');

		await wrapper.get('[data-testid="operator-add-admin"]').trigger('click');
		const modal = wrapper.get('[role="dialog"][aria-label="Add platform admin"]');
		const [userSelect, roleSelect] = modal.findAll('select');
		expect(userSelect!.findAll('option').map((o) => o.text())).toEqual([
			'Select a user…',
			'Kim · kim@owlat.example',
		]);
		await userSelect!.setValue('user_kim');
		await roleSelect!.setValue('superadmin');
		await button(wrapper, 'Add admin').at(-1)!.trigger('click');
		await flushPromises();
		expect(ops['Add platform admin']).toHaveBeenCalledWith({
			authUserId: 'user_kim',
			email: 'kim@owlat.example',
			role: 'superadmin',
		});
		wrapper.unmount();
	});
});
