import {
	defineAsyncComponent,
	defineComponent,
	h,
	type AsyncComponentLoader,
	type Component,
} from 'vue';
import PanelLoading from './PanelLoading.vue';

// The analysis, render-options and diff panels are secondary to the preview:
// settings and diff open on demand, analysis only once there is something to
// report. Each loads with its first render instead of with the previewer's
// chunk. Nothing else may import these modules statically, or the bundler
// folds them back into that chunk.
function lazyPanel<T extends Component>(
	loader: AsyncComponentLoader<T>,
	state: { label: string; placement?: 'top' | 'bottom' }
): T {
	// A failed chunk resolves to this stand-in instead of rejecting: Vue reports
	// a rejected loader to every ancestor's errorCaptured, and the host's error
	// boundary would swap the whole editor for its fallback over one panel. The
	// browser keeps a failed module for the page's life, so the stand-in stays
	// until a reload, which is what it offers.
	const Failed = defineComponent({
		name: 'PreviewPanelFailed',
		// The panel's own props and listeners have nowhere to go.
		inheritAttrs: false,
		setup: () => () => h(PanelLoading, { ...state, failed: true }),
	});
	return defineAsyncComponent({
		loader: () => (loader() as Promise<T | { default: T }>).catch(() => Failed as T),
		loadingComponent: { render: () => h(PanelLoading, state) },
		// A host's <Suspense> would otherwise hold the panel without a loading state.
		suspensible: false,
	});
}

export const AnalysisPanel = lazyPanel(() => import('./AnalysisPanel.vue'), {
	label: 'analysis',
	placement: 'bottom',
});
export const RenderOptionsPanel = lazyPanel(() => import('./RenderOptionsPanel.vue'), {
	label: 'render options',
});
export const DiffPanel = lazyPanel(() => import('./DiffPanel.vue'), {
	label: 'changes',
});
