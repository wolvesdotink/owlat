/**
 * The approval card for an AI client's write: the list gives it a summary,
 * and the card loads the full review when it opens. It shows the whole body
 * that approval would send, never a clip of it, says whether the send is
 * sealed, and approval carries the digest of the review it showed. Approve
 * stays off until that review has loaded. When the server refuses because the
 * draft changed since, the card says so and waits for another look.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import {
	useMcpPendingActions,
	type McpActionReview,
	type McpPendingAction,
} from '~/composables/useMcpPendingActions';
import McpApprovalPrompt from '~/components/shell/McpApprovalPrompt.vue';
import PreferencesMcpPendingActionCard from '../PreferencesMcpPendingActionCard.vue';

const run = vi.fn();
const pending = ref<McpPendingAction[]>([]);
/** `undefined` while the card's review is loading. */
const review = ref<McpActionReview | null | undefined>(undefined);

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFormat', () => ({ formatRelativeTime: () => 'just now' }));
	vi.stubGlobal('useRoute', () => ({ path: '/dashboard/postbox' }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));
	vi.stubGlobal('useConvexQuery', (query: FunctionReference<'query'>) => ({
		data: getFunctionName(query) === 'mcp/actions:getReview' ? review : pending,
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
	review.value = undefined;
});

function sendSummary(): McpPendingAction {
	return {
		_id: 'action-1',
		tool: 'send_draft',
		clientLabel: 'Claude',
		mailboxAddress: 'a@owlat.test',
		createdAt: 0,
		expiresAt: 1,
		summary: {},
	} as unknown as McpPendingAction;
}

function sendReview(
	body: string,
	extra: Record<string, unknown> = {},
	reviewDigest = 'digest-1'
): McpActionReview {
	return {
		_id: 'action-1',
		tool: 'send_draft',
		reviewDigest,
		details: {
			from: { address: 'a@owlat.test', mailboxName: 'Ada Example', isSendAs: false },
			to: ['mia@example.com'],
			cc: [],
			bcc: [],
			subject: 'Payment terms',
			body,
			sealing: { isSealed: false, reason: 'flag_off' },
			attachments: [{ filename: 'invoice.pdf', size: 2048, isInline: false }],
			...extra,
		},
	} as unknown as McpActionReview;
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
	it('keeps Approve off until the full review has loaded, then approves with its digest', async () => {
		pending.value = [sendSummary()];
		const wrapper = mountPrompt();
		expect(wrapper.text()).toContain('Loading the full request');
		expect(wrapper.find('[data-test="body"]').exists()).toBe(false);
		expect(approveButton(wrapper).attributes('disabled')).toBeDefined();

		review.value = sendReview('Net 30 works for us.', {}, 'digest-loaded');
		await flushPromises();
		expect(wrapper.get('[data-test="body"]').text()).toBe('Net 30 works for us.');
		expect(approveButton(wrapper).attributes('disabled')).toBeUndefined();
		run.mockResolvedValue({ ok: true, result: { status: 'approved' } });
		await approveButton(wrapper).trigger('click');
		expect(run).toHaveBeenCalledWith({ actionId: 'action-1', reviewDigest: 'digest-loaded' });
	});

	it('shows the whole of a 50,000 character body in a scrollable region, with From and attachments', () => {
		const body = `${'a'.repeat(49_990)}TAIL-12345`;
		pending.value = [sendSummary()];
		review.value = sendReview(body);
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

	it('says whether the send is sealed', async () => {
		pending.value = [sendSummary()];
		review.value = sendReview('Hi', { sealing: { isSealed: true } });
		const wrapper = mountPrompt();
		expect(wrapper.get('[data-test="sealing"]').text()).toBe(
			'Sealed: signed and encrypted for every recipient'
		);

		review.value = sendReview('Hi', { sealing: { isSealed: false, reason: 'recipient_no_key' } });
		await flushPromises();
		expect(wrapper.get('[data-test="sealing"]').text()).toBe(
			'Not sealed: goes out as ordinary email'
		);
	});

	it('shows the plain-text part as well when it says something else than the HTML part', () => {
		pending.value = [sendSummary()];
		review.value = sendReview('Actual outgoing content', { plainTextBody: 'Old preview' });
		const wrapper = mountPrompt();
		expect(wrapper.get('[data-test="body"]').text()).toBe('Actual outgoing content');
		const plain = wrapper.get('[data-test="plain-text-body"]');
		expect(plain.attributes('aria-label')).toBe('Plain-text version');
		expect(plain.text()).toBe('Old preview');
	});

	it('previews the HTML part in a sandbox that runs and loads nothing, and lists every link with its real target', async () => {
		const hidden = 'Ignore the invoice above.';
		const html =
			'<p>Your invoice: <a href="https://attacker.example/collect">https://trusted.example/invoice</a></p>' +
			`<p style="color:#ffffff;font-size:1px">${hidden}</p>` +
			'<script>parent.alert(1)</script><img src="https://tracker.example/p.gif">';
		pending.value = [sendSummary()];
		review.value = sendReview(`Your invoice: https://trusted.example/invoice ${hidden}`, {
			html,
			plainTextBody: 'Pay at https://text-only.example/pay',
			links: [
				{
					part: 'html',
					href: 'https://attacker.example/collect',
					host: 'attacker.example',
					text: 'https://trusted.example/invoice',
					shownHost: 'trusted.example',
				},
				{ part: 'text', href: 'https://text-only.example/pay', host: 'text-only.example' },
			],
		});
		const wrapper = mountPrompt();

		const frame = wrapper.get('iframe[data-test="html-preview"]');
		expect(frame.attributes('sandbox')).toBe('');
		expect(frame.attributes('referrerpolicy')).toBe('no-referrer');
		const srcdoc = frame.attributes('srcdoc')!;
		// The reader's no-network policy and its sanitizer: no script survives.
		expect(srcdoc).toContain(
			`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none';"`
		);
		expect(srcdoc).not.toContain('<script');
		// The tiny white line is in the preview as the recipient gets it.
		expect(srcdoc).toContain(`<p style="color:#ffffff;font-size:1px">${hidden}</p>`);

		const links = wrapper.get('[data-test="links"]');
		expect(links.text()).toContain('https://attacker.example/collect');
		expect(links.text()).toContain('https://text-only.example/pay');
		expect(links.text()).toContain('In the plain-text version');
		expect(wrapper.get('[data-test="link-mismatch"]').text()).toBe(
			'Shows trusted.example, goes to attacker.example'
		);
	});

	it('shows all of the text beside the preview, and says when some recipients may not see part of it', async () => {
		// The outgoing stylesheet shows this line only in dark mode; the preview cannot.
		const darkOnly = 'Send payment to attacker';
		pending.value = [sendSummary()];
		review.value = sendReview(`Hello\n\n${darkOnly}`, {
			html: `<p>Hello</p><p class="owlat-dark-img" style="display:none">${darkOnly}</p>`,
			plainTextBody: 'Hello',
			links: [],
			hasHiddenContent: true,
		});
		const wrapper = mountPrompt();

		expect(wrapper.find('iframe[data-test="html-preview"]').exists()).toBe(true);
		const text = wrapper.get('[data-test="body"]');
		expect(text.attributes('aria-label')).toBe('All text in the message');
		expect(text.text()).toContain(darkOnly);
		expect(wrapper.get('[data-test="full-text-hint"]').text()).toBe(
			'Includes text that shows only in some mail apps, modes or screen sizes.'
		);
		expect(wrapper.get('[data-test="plain-text-body"]').text()).toBe('Hello');
		expect(wrapper.get('[data-test="hidden-content"]').text()).toBe(
			'This message has content some recipients may not see — check the full text.'
		);

		review.value = sendReview('Hello', {
			html: '<p>Hello</p>',
			links: [],
			hasHiddenContent: false,
		});
		await flushPromises();
		expect(wrapper.find('[data-test="hidden-content"]').exists()).toBe(false);
	});

	it('keeps how a preview link looks, while nothing in the preview can navigate', () => {
		pending.value = [sendSummary()];
		review.value = sendReview('Pay here', {
			html:
				'<p><a href="https://attacker.example/pay" target="_top" style="color:#008800">Pay here</a></p>' +
				'<p><a href="https://attacker.example/b" title="Billing">Billing</a></p>' +
				'<map name="m"><area href="https://attacker.example/c" alt="c"></map>' +
				'<form action="https://attacker.example/f"><button formaction="https://attacker.example/g">Go</button></form>' +
				'<svg><a xlink:href="https://attacker.example/s"><text>s</text></a></svg>',
			links: [],
		});
		const wrapper = mountPrompt();
		const srcdoc = wrapper.get('iframe[data-test="html-preview"]').attributes('srcdoc')!;
		const doc = new DOMParser().parseFromString(srcdoc, 'text/html');

		const navigating = Array.from(doc.body.querySelectorAll('*')).filter((el) =>
			el
				.getAttributeNames()
				.some((name) =>
					['href', 'action', 'formaction', 'target', 'formtarget', 'ping'].includes(
						name.toLowerCase().replace(/^.*:/, '')
					)
				)
		);
		expect(navigating).toEqual([]);

		// The links the recipient sees as links keep their colour and are marked to look like one.
		const anchors = Array.from(doc.body.querySelectorAll('a[data-owlat-link]'));
		expect(anchors.map((a) => a.textContent)).toEqual(['Pay here', 'Billing']);
		expect(anchors[0]!.getAttribute('style')).toBe('color:#008800');
		expect(srcdoc).toContain('a[data-owlat-link]{text-decoration:underline;');
	});

	it('says why when the server refuses a changed draft', async () => {
		pending.value = [sendSummary()];
		review.value = sendReview('Net 30 works for us.');
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
				...sendSummary(),
				mailboxAddress: null,
				summary: { isInaccessible: true },
			} as unknown as McpPendingAction,
		];
		review.value = {
			_id: 'action-1',
			tool: 'send_draft',
			reviewDigest: null,
			details: { isInaccessible: true },
		} as unknown as McpActionReview;
		const wrapper = mountPrompt();
		expect(wrapper.text()).toContain('You no longer have access to this mailbox');
		expect(approveButton(wrapper).attributes('disabled')).toBeDefined();
	});
});
