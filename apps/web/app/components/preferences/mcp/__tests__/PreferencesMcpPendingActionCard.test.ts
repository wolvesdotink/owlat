/**
 * The approval card for an AI client's write: it shows the whole body that
 * approval would send, never a clip of it, and approval carries the digest of
 * what the card showed. When the server refuses because the draft changed
 * since, the card says so and waits for another look.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useMcpPendingActions, type McpPendingAction } from '~/composables/useMcpPendingActions';
import McpApprovalPrompt from '~/components/shell/McpApprovalPrompt.vue';
import PreferencesMcpPendingActionCard from '../PreferencesMcpPendingActionCard.vue';

const run = vi.fn();
const pending = ref<McpPendingAction[]>([]);

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFormat', () => ({ formatRelativeTime: () => 'just now' }));
	vi.stubGlobal('useRoute', () => ({ path: '/dashboard/postbox' }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));
	vi.stubGlobal('useConvexQuery', () => ({
		data: pending,
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useMcpPendingActions', useMcpPendingActions);
});

beforeEach(() => {
	run.mockReset();
});

function sendAction(body: string, reviewDigest = 'digest-1'): McpPendingAction {
	return {
		_id: 'action-1',
		tool: 'send_draft',
		clientLabel: 'Claude',
		mailboxAddress: 'a@owlat.test',
		createdAt: 0,
		expiresAt: 1,
		reviewDigest,
		details: {
			from: { address: 'a@owlat.test', mailboxName: 'Ada Example', isSendAs: false },
			to: ['mia@example.com'],
			cc: [],
			bcc: [],
			subject: 'Payment terms',
			body,
			attachments: [{ filename: 'invoice.pdf', size: 2048, isInline: false }],
		},
	} as unknown as McpPendingAction;
}

function mountPrompt() {
	return mount(McpApprovalPrompt, {
		global: {
			plugins: [createTestI18n()],
			components: { PreferencesMcpPendingActionCard },
			stubs: {
				NuxtLink: { template: '<a><slot /></a>' },
				UiButton: {
					props: ['disabled'],
					emits: ['click'],
					template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
}

function approveButton(wrapper: ReturnType<typeof mountPrompt>) {
	return wrapper.findAll('button').find((button) => button.text() === 'Approve and send')!;
}

describe('MCP approval card', () => {
	it('shows the whole of a 50,000 character body in a scrollable region, with From and attachments', () => {
		const body = `${'a'.repeat(49_990)}TAIL-12345`;
		pending.value = [sendAction(body)];
		const wrapper = mountPrompt();
		const region = wrapper.get('[data-test="body"]');
		expect(region.attributes('role')).toBe('region');
		expect(region.attributes('tabindex')).toBe('0');
		expect(region.attributes('aria-label')).toBe('Full message');
		expect(region.text()).toBe(body);
		expect(wrapper.text()).toContain('a@owlat.test');
		expect(wrapper.get('[data-test="attachments"]').text()).toContain('invoice.pdf');
		expect(wrapper.get('[data-test="attachments"]').text()).toContain('2.0 KB');
	});

	it('approves with the digest it showed, and says why when the server refuses a changed draft', async () => {
		pending.value = [sendAction('Net 30 works for us.')];
		run.mockResolvedValue({
			ok: true,
			result: {
				status: 'pending',
				isChanged: true,
				failureMessage: 'This changed after you opened it.',
			},
		});
		const wrapper = mountPrompt();
		await approveButton(wrapper).trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith({ actionId: 'action-1', reviewDigest: 'digest-1' });
		expect(wrapper.get('[role="alert"]').text()).toBe(
			'This changed after you opened it. Check the updated details, then approve again.'
		);
	});

	it('hides the content and cannot approve once the mailbox is out of reach', () => {
		pending.value = [
			{
				...sendAction('secret'),
				mailboxAddress: null,
				reviewDigest: null,
				details: { isInaccessible: true },
			} as unknown as McpPendingAction,
		];
		const wrapper = mountPrompt();
		expect(wrapper.text()).toContain('You no longer have access to this mailbox');
		expect(wrapper.text()).not.toContain('secret');
		expect(approveButton(wrapper).attributes('disabled')).toBeDefined();
	});
});
