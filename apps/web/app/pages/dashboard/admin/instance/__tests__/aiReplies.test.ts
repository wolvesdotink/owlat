// @vitest-environment happy-dom
/**
 * AI replies — one page, one top control over drafting and automatic sending.
 *
 * Pinned here, against the real catalog:
 *   - the control reads the stored settings as Draft only / Send automatically
 *     / Off, and each choice runs exactly the writes that make it true (Off stops
 *     sending BEFORE the agent flag goes off; turning on enables the agent first);
 *   - the when-to-send settings only show while sending automatically, and the
 *     global threshold gives way to per-category rules when those are on;
 *   - the `ai.autonomy` flag's state is shown with a link to Features, and the
 *     rules queries (which assert that flag server-side) never run while it's off;
 *   - no "legacy" wording and no duplicate Auto-reply switch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { installNuxtStubs, mountDashboardPage, queryResult } from '~/__tests__/a11y';
import { expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import AiRepliesPage from '../ai-replies.vue';

const flags = ref<Record<string, boolean>>({});
const config = ref<Record<string, unknown> | null>(null);
const writes: Array<{ fn: string; args: unknown }> = [];
const queryArgs = new Map<string, unknown>();
const showToast = vi.fn();

const GET_CONFIG = getFunctionName(api.agentConfigMutations.getConfig);
const SET_FLAG = getFunctionName(api.workspaces.featureFlags.setFeatureFlag);
const SET_MODE = getFunctionName(api.agentConfigMutations.setReplyMode);

beforeEach(() => {
	flags.value = { ai: true, inbox: true, 'ai.agent': true, 'ai.autonomy': false };
	config.value = null;
	writes.length = 0;
	queryArgs.clear();
	showToast.mockReset();
	installNuxtStubs({
		...i18nStubs,
		useFeatureFlag: () => ({
			flags,
			isEnabled: (k: string) => flags.value[k] === true,
			isLoading: ref(false),
			error: ref(null),
		}),
		useConvexQuery: (fn: Parameters<typeof getFunctionName>[0], args: unknown) => {
			const name = getFunctionName(fn);
			queryArgs.set(name, typeof args === 'function' ? (args as () => unknown)() : args);
			if (name === GET_CONFIG) return { data: config, isLoading: ref(false), error: ref(null) };
			return queryResult(undefined);
		},
		useBackendOperation: (fn: Parameters<typeof getFunctionName>[0]) => {
			const name = getFunctionName(fn);
			return {
				run: vi.fn(async (args: { flag?: string; value?: boolean; mode?: string }) => {
					writes.push({ fn: name, args });
					// Mirror the live subscriptions so the derived mode follows.
					if (name === SET_FLAG && args.flag) {
						flags.value = { ...flags.value, [args.flag]: args.value === true };
					}
					if (name === SET_MODE) {
						config.value = {
							...config.value,
							isAutoReplyEnabled: args.mode === 'auto',
							isShadowMode: args.mode !== 'auto',
						};
					}
					return { ok: true, result: null };
				}),
				isLoading: ref(false),
				error: ref(null),
			};
		},
		useToast: () => ({ showToast }),
		useUnsavedChanges: () => ({
			showDialog: ref(false),
			confirmDiscard: vi.fn(),
			confirmSave: vi.fn(),
			cancelNavigation: vi.fn(),
			setHasChanges: vi.fn(),
		}),
	});
});

function mountPage() {
	return mountDashboardPage(AiRepliesPage, {
		stubs: {
			UnsavedChangesDialog: true,
			UiErrorAlert: true,
			UiSkeleton: true,
			UiSkeletonText: true,
			AutonomyWorkingHours: true,
			AutonomyDemotionAlerts: true,
			AutonomyGraduationNudge: true,
			AutonomyRuleEditor: true,
			AutonomyHandlingRulesManager: true,
			AutonomyAskEagernessDial: true,
			AutonomyFeedbackStatsCard: true,
			AutonomyLearningControls: true,
			AgentKnowledgeBackfillCard: true,
			AgentKnowledgeRelationBackfillCard: true,
			UiCard: { template: '<div><slot /></div>' },
		},
	});
}

const radio = (wrapper: ReturnType<typeof mountPage>, mode: string) =>
	wrapper.get(`[data-testid="ai-reply-mode-${mode}"] input`);

describe('AI replies page', () => {
	it('opens on Draft only, with one control and no legacy wording', () => {
		const wrapper = mountPage();
		expect((radio(wrapper, 'draft').element as HTMLInputElement).checked).toBe(true);
		expect(wrapper.text()).toContain('Send automatically when confident');
		expect(wrapper.text().toLowerCase()).not.toContain('legacy');
		expect(wrapper.text()).not.toContain('Auto-Reply');
		expect(wrapper.find('[data-testid="ai-replies-when"]').exists()).toBe(false);
		expectFullyLocalized(wrapper);
	});

	it('arms automatic sending with one write and shows when-to-send settings', async () => {
		const wrapper = mountPage();
		await radio(wrapper, 'auto').trigger('change');
		await flushPromises();

		expect(writes).toEqual([{ fn: SET_MODE, args: { mode: 'auto' } }]);
		expect((radio(wrapper, 'auto').element as HTMLInputElement).checked).toBe(true);
		const when = wrapper.get('[data-testid="ai-replies-when"]');
		expect(when.text()).toContain('Daily limit');
		expect(showToast).toHaveBeenCalledWith(
			'AI replies now send automatically when the AI is confident'
		);
	});

	it('hands the threshold to the per-category rules when those are on', () => {
		flags.value = { ...flags.value, 'ai.autonomy': true };
		config.value = { isAutoReplyEnabled: true, isShadowMode: false };
		const wrapper = mountPage();
		const when = wrapper.get('[data-testid="ai-replies-when"]');
		expect(when.text()).toContain('Each rule below sets how sure the AI must be');
		expect(when.find('#ai-replies-threshold').exists()).toBe(false);
		expect(wrapper.find('[data-testid="ai-replies-rules"]').exists()).toBe(true);
	});

	it('Off stops sending first, then turns the agent off', async () => {
		config.value = { isAutoReplyEnabled: true, isShadowMode: false };
		const wrapper = mountPage();
		await radio(wrapper, 'off').trigger('change');
		await flushPromises();

		expect(writes).toEqual([
			{ fn: SET_MODE, args: { mode: 'draft' } },
			{ fn: SET_FLAG, args: { flag: 'ai.agent', value: false } },
		]);
		expect((radio(wrapper, 'off').element as HTMLInputElement).checked).toBe(true);
	});

	it('turning on from Off enables the agent before setting the mode', async () => {
		flags.value = { ...flags.value, 'ai.agent': false };
		const wrapper = mountPage();
		expect((radio(wrapper, 'off').element as HTMLInputElement).checked).toBe(true);
		await radio(wrapper, 'draft').trigger('change');
		await flushPromises();

		expect(writes).toEqual([
			{ fn: SET_FLAG, args: { flag: 'ai.agent', value: true } },
			{ fn: SET_MODE, args: { mode: 'draft' } },
		]);
	});

	it('only offers Off while AI or the team inbox is off, and says where to fix it', () => {
		flags.value = { ai: false, inbox: true, 'ai.agent': false };
		const wrapper = mountPage();
		expect(radio(wrapper, 'draft').attributes('disabled')).toBeDefined();
		expect(radio(wrapper, 'auto').attributes('disabled')).toBeDefined();
		expect(radio(wrapper, 'off').attributes('disabled')).toBeUndefined();
		expect(wrapper.get('[data-testid="ai-replies-needs-features"]').text()).toContain(
			'AI replies need AI features and the team inbox turned on.'
		);
	});

	it('shows the rules flag state with a link to Features, and skips the rules queries while it is off', () => {
		const wrapper = mountPage();
		const flagRow = wrapper.get('[data-testid="ai-replies-rules-flag"]');
		expect(flagRow.text()).toContain('Rules for each type of message:');
		expect(flagRow.text()).toContain('Off');
		expect(flagRow.text()).toContain('Change in Features');
		expect(wrapper.find('[data-testid="ai-replies-rules-off"]').exists()).toBe(true);
		// The rules section is not mounted, so its queries never subscribe.
		expect(queryArgs.has(getFunctionName(api.autonomy.listRules))).toBe(false);
		expect(queryArgs.has(getFunctionName(api.autonomyOutcome.listAutoDemotions))).toBe(false);
	});
});
