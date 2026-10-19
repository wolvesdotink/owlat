import { defineAsyncComponent, h, type AsyncComponentLoader, type Component } from 'vue';
import PanelLoading from './PanelLoading.vue';

// The analysis, render-options and diff panels are secondary to the preview:
// settings and diff open on demand, analysis only once there is something to
// report. Each loads with its first render instead of with the previewer's
// chunk. Nothing else may import these modules statically, or the bundler
// folds them back into that chunk.
function lazyPanel<T extends Component>(
	loader: AsyncComponentLoader<T>,
	state: { label: string; retryHint: string; placement?: 'top' | 'bottom' }
): T {
	return defineAsyncComponent({
		loader,
		loadingComponent: { render: () => h(PanelLoading, state) },
		// A failed load is retried the next time the panel renders.
		errorComponent: { render: () => h(PanelLoading, { ...state, failed: true }) },
		// A host's <Suspense> would otherwise hold the panel without a loading state.
		suspensible: false,
	});
}

export const AnalysisPanel = lazyPanel(() => import('./AnalysisPanel.vue'), {
	label: 'analysis',
	retryHint: 'Reopen the preview to try again.',
	placement: 'bottom',
});
export const RenderOptionsPanel = lazyPanel(() => import('./RenderOptionsPanel.vue'), {
	label: 'render options',
	retryHint: 'Close and reopen them to try again.',
});
export const DiffPanel = lazyPanel(() => import('./DiffPanel.vue'), {
	label: 'changes',
	retryHint: 'Close and reopen them to try again.',
});
