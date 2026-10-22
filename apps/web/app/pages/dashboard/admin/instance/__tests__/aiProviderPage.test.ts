/**
 * The AI provider page, mounted with its real form composable:
 *   - "Save and leave" stays on the page when the routing card's save was
 *     refused (a version conflict reloads the card and clears its dirty flag,
 *     so only the save's answer tells), and leaves once both saves landed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, onMounted, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useAiProviderForm } from '~/composables/useAiProviderForm';
import { DECISION_HEALTH_HOURS } from '~/utils/aiDecisionPlane';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

/** What the routing card's save answers, and whether it starts dirty. */
const routingSave = vi.fn(async () => true);
let isRoutingDirty = true;
const RoutingCardStub = defineComponent({
	emits: ['dirty'],
	setup(_props, { emit, expose }) {
		// Like the real card, a save leaves it clean whether it landed or met a
		// conflict (which reloads the newer policy); only the answer differs.
		expose({
			save: async () => {
				const isSaved = await routingSave();
				emit('dirty', false);
				return isSaved;
			},
		});
		onMounted(() => emit('dirty', isRoutingDirty));
		return () => h('div', { 'data-testid': 'routing-card' });
	},
});

let onSave: (() => Promise<void>) | undefined;
const config = ref<Record<string, unknown>>({});

function install() {
	installNuxtStubs({
		...i18nStubs,
		useAiProviderForm,
		DECISION_HEALTH_HOURS,
		useOrganizationQuery: () => ({
			data: config,
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}),
		useBackendOperation: () => ({
			run: vi.fn(async () => ({ ok: true, result: { ok: true } })),
			isLoading: ref(false),
		}),
		useToast: () => ({ showToast: vi.fn() }),
		useFeatureFlag: () => ({
			isEnabled: () => false,
			isLoading: ref(false),
			error: ref(null),
		}),
		useUnsavedChanges: (opts: { onSave: () => Promise<void> }) => {
			onSave = opts.onSave;
			return {
				showDialog: ref(false),
				isSavingBeforeLeave: ref(false),
				confirmDiscard: vi.fn(),
				confirmSave: vi.fn(),
				cancelNavigation: vi.fn(),
				setHasChanges: vi.fn(),
			};
		},
	});
}

async function mountPage() {
	install();
	const { default: Page } = await import('../ai-provider.vue');
	const slot = { template: '<div><slot /></div>' };
	return mount(Page, {
		global: {
			plugins: [createTestI18n()],
			// A template auto-import the test build does not resolve.
			mocks: { DECISION_HEALTH_HOURS },
			stubs: {
				Icon: true,
				UiSkeleton: true,
				UiSkeletonText: true,
				UiCard: slot,
				UiQueryBoundary: slot,
				UiDisclosure: slot,
				UiPageHeader: true,
				UiSelect: true,
				UiInput: true,
				UiButton: { template: '<button><slot /></button>' },
				UiUnsavedChangesDialog: true,
				SettingsAiKeyField: {
					props: ['error'],
					template: '<div data-testid="key-field">{{ error }}</div>',
				},
				SettingsAiModelPicker: true,
				SettingsAiDecisionCard: true,
				SettingsAiEmbeddingSpaceCard: true,
				SettingsAiRemoveConfigCard: true,
				SettingsAiRoutingPolicyCard: RoutingCardStub,
			},
		},
	});
}

beforeEach(() => {
	onSave = undefined;
	isRoutingDirty = true;
	routingSave.mockReset();
	routingSave.mockResolvedValue(true);
	config.value = {
		configured: true,
		languageProviderKind: 'openai',
		modelFast: 'gpt-5.6-luna',
		modelCapable: 'gpt-5.6-sol',
		isLanguageKeySet: true,
		embeddingProviderKind: 'local',
		resolvedEmbeddingModel: 'nomic-embed-text',
		isEmbeddingKeySet: false,
	};
});

describe('the AI provider page', () => {
	it('stays when the routing save is refused, and leaves once it lands (F3)', async () => {
		const w = await mountPage();
		await flushPromises();
		routingSave.mockResolvedValueOnce(false);
		await expect(onSave!()).rejects.toThrow('Save failed');
		expect(routingSave).toHaveBeenCalledTimes(1);
		// Edited again, then saved.
		w.findComponent(RoutingCardStub).vm.$emit('dirty', true);
		await expect(onSave!()).resolves.toBeUndefined();
		expect(routingSave).toHaveBeenCalledTimes(2);
		w.unmount();
	});

	it('does not save the routing card when it has nothing unsaved', async () => {
		isRoutingDirty = false;
		const w = await mountPage();
		await flushPromises();
		await expect(onSave!()).resolves.toBeUndefined();
		expect(routingSave).not.toHaveBeenCalled();
		w.unmount();
	});
});
