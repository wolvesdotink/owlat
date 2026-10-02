// @vitest-environment happy-dom
/**
 * A failed settings read is not the defaults (#1097). Each form below saves
 * its whole draft or record, so a form that rendered from its defaults after a
 * failed read would write them over the stored settings the moment the
 * operator changed one field and saved.
 *
 * Each form is mounted with its settings read failing. It must show the query
 * boundary's error with a working Try again, and nothing on it may trigger a
 * write: every field it would offer is edited, every button clicked and every
 * form submitted. Once the read recovers, the form shows the stored values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { defineComponent, nextTick, ref, type Component, type Ref } from 'vue';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { api } from '@owlat/api';
import { DEFAULT_TRUSTED_ARC_FORWARDERS } from '@owlat/shared/arcTrust';
import { resolveBrandKitDesign } from '@owlat/shared/brandKit';
import { installNuxtStubs, mountDashboardPage } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';

const failure = () => new Error('[CONVEX Q(x:y)] [Request ID: 1] Server Error');

const refetch = vi.fn();
const mutation = vi.fn(async () => ({ ok: true, result: null }));

interface Read {
	data: Ref<unknown>;
	error: Ref<Error | null>;
}

/** One read per Convex function: failing, unless the case answers it. */
let reads = new Map<string, Read>();

function readFor(fn: FunctionReference<'query'>): Read {
	const name = getFunctionName(fn);
	let read = reads.get(name);
	if (!read) {
		read = { data: ref(undefined), error: ref(failure()) };
		reads.set(name, read);
	}
	return read;
}

function answer(fn: FunctionReference<'query'>, value: unknown) {
	const read = readFor(fn);
	read.data.value = value;
	read.error.value = null;
}

function query(fn: FunctionReference<'query'>) {
	const read = readFor(fn);
	return {
		data: read.data,
		isLoading: ref(false),
		isRefetching: ref(false),
		error: read.error,
		refetch,
		reset: vi.fn(),
	};
}

/** The boundary's contract, without its copy: error → marker + retry, else the content. */
const QueryBoundaryStub = defineComponent({
	props: {
		error: { type: null, default: null },
		loading: { type: Boolean, default: false },
	},
	emits: ['retry'],
	template: `
		<div v-if="error" data-testid="query-error">
			<button type="button" data-testid="query-retry" @click="$emit('retry')" />
		</div>
		<div v-else-if="loading" data-testid="query-loading" />
		<slot v-else />
	`,
});

/** A real button, so `disabled` holds the way it does in the app. */
const ButtonStub = defineComponent({
	props: { disabled: Boolean, loading: Boolean, type: { type: String, default: 'button' } },
	emits: ['click'],
	template: `<button :type="type" :disabled="disabled || loading" @click="$emit('click', $event)"><slot /></button>`,
});

const InputStub = defineComponent({
	props: { modelValue: { type: String, default: '' } },
	emits: ['update:modelValue'],
	template: `<input data-testid="ui-input" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
});

const passthrough = { template: '<div><slot /><slot name="footer" /></div>' };

const mailbox = { _id: 'mb1', address: 'team@example.com' };

interface FormCase {
	name: string;
	load: () => Promise<{ default: Component }>;
	/** Reads that answer even in the failing mount: only the form's own read fails. */
	answered?: () => void;
	/** Fields an operator would edit before saving, by selector. */
	edits: Array<[selector: string, value: string]>;
	/** Answer the failed read with a stored record. */
	recover: () => void;
	/** After recovery: the stored values are on screen, not the defaults. */
	showsStored: (wrapper: VueWrapper) => Promise<void> | void;
	stubs?: () => Record<string, unknown>;
}

const FORMS: FormCase[] = [
	{
		name: 'brand kit',
		load: () => import('../admin/instance/brand-kit.vue'),
		edits: [
			['#brand-kit-width', '640'],
			['[data-testid="ui-input"]', 'Northwind'],
		],
		recover: () =>
			answer(api.workspaces.brandKit.get, {
				design: resolveBrandKitDesign(
					{
						primaryColor: '#112233',
						fontFamily: 'Georgia, serif',
						backgroundColor: '#fafafa',
						baseWidth: 560,
					},
					{ footerCompanyName: 'Stored Company' }
				),
				logos: { light: null, dark: null },
			}),
		showsStored: (wrapper) => {
			expect((wrapper.find('#brand-kit-width').element as HTMLInputElement).value).toBe('560');
			expect((wrapper.find('[data-testid="ui-input"]').element as HTMLInputElement).value).toBe(
				'Stored Company'
			);
		},
		stubs: () => ({
			useOrganizationContext: () => ({ organization: ref(null) }),
		}),
	},
	{
		name: 'AI replies',
		load: () => import('../admin/instance/ai-replies.vue'),
		edits: [['#ai-replies-tone', 'Warm and brief']],
		recover: () =>
			answer(api.agentConfigMutations.getConfig, {
				confidenceThreshold: 0.9,
				maxDailyAutoReplies: 5,
				toneDescription: 'Formal',
				coalesceWindowMs: 60000,
			}),
		showsStored: (wrapper) => {
			expect((wrapper.find('#ai-replies-tone').element as HTMLTextAreaElement).value).toBe(
				'Formal'
			);
		},
	},
	{
		name: 'vacation responder',
		load: () => import('../preferences/vacation.vue'),
		edits: [['#draft-subject', 'Away']],
		recover: () =>
			answer(api.mail.vacation.get, {
				_id: 'v1',
				mailboxId: mailbox._id,
				isEnabled: true,
				subject: 'Out until Monday',
				bodyText: 'Back on Monday.',
				replyIntervalDays: 3,
			}),
		showsStored: (wrapper) => {
			expect((wrapper.find('#draft-subject').element as HTMLInputElement).value).toBe(
				'Out until Monday'
			);
		},
		stubs: () => ({
			usePostboxMailbox: () => ({
				currentMailbox: ref(mailbox),
				isLoading: ref(false),
				error: ref(null),
				refetch: vi.fn(),
			}),
		}),
	},
	{
		name: 'provider routing',
		load: () => import('../admin/delivery/provider-routing.vue'),
		// The catalog answers: only the stored routes are unknown, which is what
		// used to seed a fresh single-provider route over the stored one.
		answered: () =>
			answer(api.providerRoutes.listTransportCatalog, [
				{ kind: 'mta', label: 'Owlat MTA', isAvailable: true },
				{ kind: 'ses', label: 'Amazon SES', isAvailable: true },
			]),
		edits: [['#route-ip-pool', 'warm-pool-b']],
		recover: () =>
			answer(api.providerRoutes.listRoutes, [
				{
					_id: 'r1',
					messageType: 'transactional',
					strategy: 'priority_failover',
					providers: [
						{ providerType: 'mta', isEnabled: true },
						{ providerType: 'ses', isEnabled: true },
					],
					ipPool: 'warm-pool-a',
				},
			]),
		showsStored: async (wrapper) => {
			await wrapper.find('[data-testid="route-card"] button:last-of-type').trigger('click');
			expect((wrapper.find('#route-ip-pool').element as HTMLInputElement).value).toBe(
				'warm-pool-a'
			);
			expect((wrapper.find('#route-strategy').element as HTMLSelectElement).value).toBe(
				'priority_failover'
			);
		},
	},
	{
		name: 'trusted ARC forwarders',
		load: () => import('~/components/delivery/TrustedForwardersCard.vue'),
		edits: [['[data-testid="ui-input"]', 'lists.example.org']],
		recover: () =>
			answer(api.workspaces.settings.get, { trustedArcForwarders: ['forwarder.example.com'] }),
		showsStored: (wrapper) => {
			const list = wrapper.find('[data-testid="trusted-forwarders-list"]').text();
			expect(list).toContain('forwarder.example.com');
			for (const domain of DEFAULT_TRUSTED_ARC_FORWARDERS) expect(list).not.toContain(domain);
		},
	},
];

/** Everything an operator could do to the form: edit, click, submit. Twice, for opened editors. */
async function tryToSave(wrapper: VueWrapper, edits: FormCase['edits']) {
	for (let pass = 0; pass < 2; pass += 1) {
		for (const [selector, value] of edits) {
			const field = wrapper.find(selector);
			if (field.exists()) await field.setValue(value);
		}
		for (const button of wrapper.findAll('button')) {
			if (button.attributes('data-testid') === 'query-retry') continue;
			if (button.exists()) await button.trigger('click');
		}
		for (const form of wrapper.findAll('form')) {
			if (form.exists()) await form.trigger('submit');
		}
		await flushPromises();
	}
}

function mountForm(Page: Component): VueWrapper {
	return mountDashboardPage(Page, {
		components: {
			UiQueryBoundary: QueryBoundaryStub,
			UiButton: ButtonStub,
			UiInput: InputStub,
		},
		stubs: {
			UnsavedChangesDialog: true,
			UiConfirmationDialog: true,
			UiModal: passthrough,
			UiPageHeader: true,
			UiSkeleton: true,
			UiSkeletonText: true,
			UiSwitch: true,
			AiReplyModeControl: true,
			AgentKnowledgeBackfillCard: true,
			AgentKnowledgeRelationBackfillCard: true,
			AutonomyAskEagernessDial: true,
			AutonomyFeedbackStatsCard: true,
			AutonomyLearningControls: true,
			AutonomyWorkingHours: true,
			BrandKitLogoPicker: true,
			BrandKitColorField: true,
			BrandKitSwatches: true,
			BrandKitFontSelect: true,
			BrandKitSocialLinks: true,
			BrandKitPreview: true,
			BrandKitImportDialog: true,
			UiTextarea: true,
			DashboardListSkeleton: true,
			DeliveryReferenceRelayNotice: true,
			DeliveryRelayDomainStatus: true,
			DeliveryProviderRouteSummary: true,
			DeliveryProviderRouteProviderList: true,
			DeliveryDeliverabilityFallbackEditor: true,
			I18nT: true,
			NuxtLink: { template: '<a><slot /></a>' },
			// Its two actions, in its order: Reset, then Edit.
			DeliveryProviderRouteCard: {
				emits: ['edit', 'reset'],
				template: `<div data-testid="route-card"><button type="button" @click="$emit('reset')" /><button type="button" @click="$emit('edit')" /></div>`,
			},
		},
	});
}

afterEach(() => {
	refetch.mockClear();
	mutation.mockClear();
	reads = new Map();
});

describe('settings forms after a failed read (#1097)', () => {
	function install(form: FormCase) {
		installNuxtStubs({
			...i18nStubs,
			// Inert: the real guard needs a router the pages are not mounted under.
			useUnsavedChanges: () => ({
				showDialog: ref(false),
				isSavingBeforeLeave: ref(false),
				confirmDiscard: vi.fn(),
				confirmSave: vi.fn(),
				cancelNavigation: vi.fn(),
				setHasChanges: vi.fn(),
			}),
			useBackendOperation: () => ({ run: mutation, isLoading: ref(false), error: ref(null) }),
			useConvexQuery: query,
			useOrganizationQuery: query,
			...form.stubs?.(),
		});
		form.answered?.();
	}

	it.each(FORMS)('$name shows the error, and nothing on it can save', async (form) => {
		install(form);
		const { default: Page } = await form.load();
		const wrapper = mountForm(Page);
		await flushPromises();

		expect(wrapper.find('[data-testid="query-error"]').exists()).toBe(true);
		await tryToSave(wrapper, form.edits);
		expect(mutation).not.toHaveBeenCalled();

		await wrapper.find('[data-testid="query-retry"]').trigger('click');
		expect(refetch).toHaveBeenCalled();
		wrapper.unmount();
	});

	it.each(FORMS)('$name shows the stored values once the read recovers', async (form) => {
		install(form);
		const { default: Page } = await form.load();
		const wrapper = mountForm(Page);
		await flushPromises();

		form.recover();
		await nextTick();
		await flushPromises();

		expect(wrapper.find('[data-testid="query-error"]').exists()).toBe(false);
		await form.showsStored(wrapper);
		wrapper.unmount();
	});
});
