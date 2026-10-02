/**
 * Reading of a send-time preview (`campaigns/sendTimeQueries.previewSendTimes`)
 * for the schedule panel.
 */

export interface SendTimePreviewData {
	hours: readonly { at: number; count: number }[];
	sampleSize: number;
	isSample: boolean;
	sources: { contact: number; organization: number; start: number; holdout: number };
	organizationBestHour: number | null;
}

export interface SendTimePreviewSummary {
	/** Recipients the prediction covers. */
	total: number;
	/** The prediction is a sample of a larger audience. */
	isSample: boolean;
	/**
	 * Nobody in the sample has history and the audience has no usual hour yet,
	 * so every optimized contact falls back to the start time.
	 */
	hasNoHistory: boolean;
}

export function summarizeSendTimePreview(preview: SendTimePreviewData): SendTimePreviewSummary {
	const { contact, organization, start } = preview.sources;
	return {
		total: preview.sampleSize,
		isSample: preview.isSample,
		hasNoHistory: preview.sampleSize > 0 && contact === 0 && organization === 0 && start > 0,
	};
}
