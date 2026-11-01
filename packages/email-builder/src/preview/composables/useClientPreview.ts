import { computed, watch, onBeforeUnmount, type Ref } from 'vue';
import type { CompatibilityReport, EmailClient } from '../types';
import { applyClientSimulation, type SimulationResult } from '../clientSimulation';
import { useCompatibilityAnalysis } from './useCompatibilityAnalysis';

/** The previewer props the client preview reads. */
interface ClientPreviewOptions {
	html: string;
	autoAnalyze: boolean;
	/** Skip previewer DOM-based simulation when renderer targetClient was used */
	useRendererSimulation: boolean;
}

/**
 * The previewer's selected email client: the HTML as that client would show
 * it, and the compatibility analysis for it. A finished analysis is handed to
 * `onReport`.
 */
export function useClientPreview(
	props: ClientPreviewOptions,
	selectedClient: Ref<EmailClient | null>,
	onReport: (report: CompatibilityReport) => void
) {
	// Compatibility analysis
	const {
		analyzeHtml,
		cancelAnalysis,
		report,
		isAnalyzing,
		error: analysisError,
	} = useCompatibilityAnalysis();

	const simulationResult = computed<SimulationResult>(() => {
		if (!selectedClient.value || props.useRendererSimulation) {
			return {
				html: props.html,
				removedCssDeclarations: 0,
				removedElements: 0,
				strippedAttributes: 0,
				blockedImages: 0,
			};
		}
		return applyClientSimulation(props.html, selectedClient.value, report.value);
	});

	/**
	 * No client, or a different one: drop any analysis in flight along with the
	 * last report and failure, which belong to the previous client.
	 */
	function clearAnalysis() {
		cancelAnalysis();
		report.value = null;
		analysisError.value = null;
	}

	async function runAnalysis() {
		if (!selectedClient.value) {
			clearAnalysis();
			return;
		}

		const result = await analyzeHtml(props.html, {
			clients: [selectedClient.value],
		});
		// null: a newer analysis (or unmount) superseded this one.
		if (result) onReport(result);
	}

	// Watch for HTML and selected client changes
	watch(
		[() => props.html, selectedClient],
		([, client], [, previousClient]) => {
			// Clearing or switching the client stops a manual (Refresh) analysis too,
			// and the old client's report is never shown as the new client's.
			if (client?.id !== previousClient?.id) clearAnalysis();
			if (client && props.autoAnalyze) runAnalysis();
		},
		{ immediate: true }
	);

	onBeforeUnmount(cancelAnalysis);

	return { report, isAnalyzing, analysisError, simulationResult, runAnalysis };
}
