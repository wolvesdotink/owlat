import {
	defineAsyncComponent,
	defineComponent,
	h,
	inject,
	onBeforeUnmount,
	provide,
	shallowRef,
	type Component,
	type InjectionKey,
} from 'vue';
import PanelLoading from './PanelLoading.vue';

// The analysis, render-options and diff panels are secondary to the preview:
// settings and diff open on demand, analysis only once there is something to
// report. Each loads with its first render instead of with the previewer's
// chunk. Nothing else may import these modules statically, or the bundler
// folds them back into that chunk.

/**
 * Set by "Try again" on the panel instance whose button was pressed: the
 * failure that answers that retry takes focus back to its own button, which
 * replaced the pressed one. Owned per instance, so another mount of the same
 * panel, or a later remount, never takes focus for it.
 */
interface RetryFocusIntent {
	requested: boolean;
}
const retryFocusKey: InjectionKey<RetryFocusIntent> = Symbol('lazyPanelRetryFocus');

/**
 * A panel loaded on first render, with a loading state for a slow chunk and a
 * contained failure state that can try again.
 *
 * A failed load resolves to the failure stand-in instead of rejecting: Vue
 * reports a rejected loader to every ancestor's errorCaptured, and a host's
 * error boundary (the web editor has one) would swap the whole editor for its
 * fallback over one panel. Vue keeps whatever a loader resolved to, so "Try
 * again" swaps in a fresh async component, which calls the loader again.
 */
export function lazyPanel<T extends Component>(
	loader: () => Promise<{ default: T }>,
	placement: 'top' | 'bottom' = 'top'
): T {
	const attempt = () =>
		defineAsyncComponent({
			loader: () => loader().catch(() => Failed as unknown as { default: T }),
			loadingComponent: { render: () => h(PanelLoading, { placement }) },
			// A host's <Suspense> would otherwise hold the panel without a loading state.
			suspensible: false,
		});
	const Failed = defineComponent({
		name: 'PreviewPanelFailed',
		// The panel's own props and listeners have nowhere to go.
		inheritAttrs: false,
		setup() {
			const intent = inject(retryFocusKey, { requested: false });
			const focusRetry = intent.requested;
			intent.requested = false;
			return () =>
				h(PanelLoading, {
					placement,
					failed: true,
					focusRetry,
					onRetry: () => {
						intent.requested = true;
						current.value = attempt();
					},
				});
		},
	});
	// Shared by every mount, so a loaded panel reopens at once and a retry
	// reaches every place the panel is shown.
	const current = shallowRef<Component>(attempt());
	return defineComponent({
		name: 'LazyPreviewPanel',
		inheritAttrs: false,
		setup(_, { attrs, slots }) {
			const intent: RetryFocusIntent = { requested: false };
			provide(retryFocusKey, intent);
			onBeforeUnmount(() => {
				intent.requested = false;
			});
			return () => h(current.value, attrs, slots);
		},
	}) as unknown as T;
}

export const AnalysisPanel = lazyPanel(() => import('./AnalysisPanel.vue'), 'bottom');
export const RenderOptionsPanel = lazyPanel(() => import('./RenderOptionsPanel.vue'));
export const DiffPanel = lazyPanel(() => import('./DiffPanel.vue'));
