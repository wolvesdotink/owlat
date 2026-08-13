'use node';

/**
 * Visualization Agent — generation action.
 *
 * Split from `./visualizationAgent.ts` (which keeps the queries, mutations and
 * live-data fetchers) because generation runs the shared LLM dispatch
 * (`lib/llm/dispatch`, itself `'use node'`), and a module carrying queries and
 * mutations cannot move to the Node runtime with it.
 */

import { v } from 'convex/values';
import { escapeHtml } from '@owlat/shared/html';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import { resolveLanguageModel } from './lib/llmProvider';
import { logInfo, logWarn } from './lib/runtimeLog';
import { runLlmText } from './lib/llm/dispatch';
import { recordLlmSpend } from './analytics/llmUsage';
import { datasetKeyValidator, isDatasetKey, type DatasetKey } from './visualizationAgent';

// ============================================================
// Internal Action: Generate Visualization
// ============================================================

/**
 * Generate a visualization from a natural language prompt.
 * Produces self-contained HTML/CSS/JS that renders in a sandboxed iframe.
 */
export const generate = internalAction({
	args: {
		visualizationId: v.id('visualizations'),
		prompt: v.string(),
		// Explicit allowlisted dataset, if the caller picked one. Otherwise
		// inferred from the prompt below.
		dataset: v.optional(datasetKeyValidator),
	},
	handler: async (ctx, args) => {
		try {
			// Step 1: Use live account data only when the caller explicitly opts in
			// with an allowlisted `dataset` key. Free-form prompts are NOT inferred
			// to real data, so the default stays illustrative as the UI promises.
			const datasetKey: DatasetKey | null =
				args.dataset && isDatasetKey(args.dataset) ? args.dataset : null;

			// Step 2: If a dataset matched, fetch the REAL numbers. This is a
			// best-effort enrichment — if the fetch fails we fall back to the
			// illustrative path rather than failing the whole generation.
			let liveData: LiveDataset | null = null;
			if (datasetKey) {
				try {
					liveData = await fetchDataset(ctx, datasetKey);
				} catch (fetchError) {
					logWarn('[visualization] live-data fetch failed, falling back to illustrative', {
						datasetKey,
						error: fetchError instanceof Error ? fetchError.message : String(fetchError),
					});
					liveData = null;
				}
			}

			// Step 3: Generate the visualization HTML. Real data flips the
			// system prompt from "illustrative only" to "use these exact
			// numbers"; the iframe sandbox model is unchanged either way.
			const system = liveData ? buildLiveSystemPrompt(liveData) : ILLUSTRATIVE_SYSTEM_PROMPT;

			const result = await runLlmText({
				model: await resolveLanguageModel(ctx, 'draft'),
				system,
				prompt: args.prompt,
			});
			logInfo('[visualization] llm call', {
				tokenUsage: result.tokenUsage,
				modelUsed: result.modelUsed,
				datasetKey,
				usedLiveData: liveData !== null,
			});
			await recordLlmSpend(ctx, 'visualization', result.tokenUsage, result.modelUsed);

			// Extract HTML from the response. Models wrap output inconsistently
			// (```html / ```HTML / bare ``` / prose around it), so try a
			// case-insensitive generic fence first, then fall back to slicing
			// the actual <!DOCTYPE…</html> document out of any surrounding text.
			let html = result.text.trim();
			const fenceMatch = html.match(/```[a-zA-Z]*\s*\n([\s\S]*?)```/);
			if (fenceMatch?.[1]) {
				html = fenceMatch[1].trim();
			}
			const docStart = html.search(/<!DOCTYPE html>|<html[\s>]/i);
			if (docStart > 0) {
				const docEnd = html.toLowerCase().lastIndexOf('</html>');
				html =
					docEnd > docStart
						? html.slice(docStart, docEnd + '</html>'.length)
						: html.slice(docStart);
			}

			// Generate a proper title from the prompt
			const titleResult = await runLlmText({
				model: await resolveLanguageModel(ctx, 'summarize'),
				prompt: `Generate a short (3-8 word) title for this visualization request: "${args.prompt}"
Respond with ONLY the title, no quotes or explanation.`,
			});
			logInfo('[visualization] llm call', {
				tokenUsage: titleResult.tokenUsage,
				modelUsed: titleResult.modelUsed,
			});
			await recordLlmSpend(
				ctx,
				'visualization_title',
				titleResult.tokenUsage,
				titleResult.modelUsed
			);

			const title = titleResult.text.trim().slice(0, 100);

			// Update the visualization with the generated content. Persist the
			// chosen dataset key in `dataQuery` so a future refresh re-fetches
			// the same allowlisted dataset (never a raw query string). Only
			// store it when live data was actually used.
			await ctx.runMutation(internal.visualizationAgent.updateGenerated, {
				id: args.visualizationId,
				title,
				html,
				dataQuery: liveData ? (datasetKey ?? undefined) : undefined,
			});
		} catch (error) {
			// Update with error state
			const errorHtml = `<!DOCTYPE html>
<html>
<body style="padding:20px;font-family:system-ui;">
<h3 style="color:#EF4444;">Generation Failed</h3>
<p>${error instanceof Error ? escapeHtml(error.message) : 'Unknown error'}</p>
<p style="color:#666;">Try rephrasing your request.</p>
</body>
</html>`;

			await ctx.runMutation(internal.visualizationAgent.updateGenerated, {
				id: args.visualizationId,
				title: 'Error',
				html: errorHtml,
			});
		}
	},
});

// ============================================================
// Live-data fetchers (read-only, allowlisted)
// ============================================================
//
// Each fetcher reads a small, bounded slice of an existing table through a
// dedicated internal query in `./visualizationAgent.ts`. They never accept
// caller-supplied query text — the dataset key (one of `DATASET_KEYS`) is the
// entire input surface.

interface LiveDataset {
	key: DatasetKey;
	// Human label shown in the visualization caption.
	label: string;
	// JSON-serializable payload of REAL numbers fed to the LLM.
	data: unknown;
}

async function fetchDataset(ctx: ActionCtx, key: DatasetKey): Promise<LiveDataset> {
	switch (key) {
		case 'email_delivery_30d': {
			const rows = await ctx.runQuery(internal.visualizationAgent.dataEmailDelivery30d, {});
			return { key, label: 'Email delivery — last 30 days', data: rows };
		}
		case 'agent_health': {
			const data = await ctx.runQuery(internal.visualizationAgent.dataAgentHealth, {});
			return { key, label: 'AI agent pipeline health', data };
		}
		case 'contact_growth': {
			const data = await ctx.runQuery(internal.visualizationAgent.dataContactGrowth, {});
			return { key, label: 'Contact growth — last 30 days', data };
		}
		case 'campaign_performance': {
			const data = await ctx.runQuery(internal.visualizationAgent.dataCampaignPerformance, {});
			return { key, label: 'Recent campaign performance', data };
		}
	}
}

// ============================================================
// Prompt construction
// ============================================================

const ILLUSTRATIVE_SYSTEM_PROMPT = `You are a data visualization expert. Generate self-contained HTML documents with embedded CSS and JavaScript that create beautiful, interactive visualizations.

IMPORTANT — this tool has NO access to the user's real account data. Any numbers you use are ILLUSTRATIVE sample data, and the output MUST make that unmistakable.

Rules:
- Output ONLY the complete HTML document (starting with <!DOCTYPE html>)
- Use inline CSS and JavaScript (no external dependencies except CDN links to Chart.js or D3.js if needed)
- Use clearly-labeled illustrative sample data (you do NOT have the user's real data)
- Include a visible caption near the chart reading exactly: "Illustrative example — not your account data"
- Make visualizations responsive and visually appealing
- Use a clean color palette: #3B82F6, #10B981, #F59E0B, #EF4444, #8B5CF6, #EC4899
- Include hover effects, tooltips, and smooth animations
- Add a title and brief description within the visualization
- The visualization should work in a sandboxed iframe with allow-scripts only
- Do NOT include any <script src="..."> tags that load from non-HTTPS URLs
- Preferred charting library: Chart.js (via CDN: https://cdn.jsdelivr.net/npm/chart.js)`;

/**
 * System prompt for the live-data path. The model is instructed to use the
 * provided REAL numbers verbatim instead of inventing illustrative ones. The
 * data is embedded as JSON; the sandbox/iframe rules are otherwise identical.
 */
function buildLiveSystemPrompt(dataset: LiveDataset): string {
	return `You are a data visualization expert. Generate self-contained HTML documents with embedded CSS and JavaScript that create beautiful, interactive visualizations.

You have been given the user's REAL account data below ("${dataset.label}"). Use these EXACT numbers — do NOT invent, round arbitrarily, or substitute illustrative sample data. If the dataset is empty, say so clearly in the visualization rather than fabricating values.

REAL DATA (JSON):
${JSON.stringify(dataset.data)}

Rules:
- Output ONLY the complete HTML document (starting with <!DOCTYPE html>)
- Use inline CSS and JavaScript (no external dependencies except CDN links to Chart.js or D3.js if needed)
- Plot ONLY the numbers from the REAL DATA block above — never fabricate additional data points
- Include a visible caption near the chart reading exactly: "${dataset.label} — live account data"
- Make visualizations responsive and visually appealing
- Use a clean color palette: #3B82F6, #10B981, #F59E0B, #EF4444, #8B5CF6, #EC4899
- Include hover effects, tooltips, and smooth animations
- Add a title and brief description within the visualization
- The visualization should work in a sandboxed iframe with allow-scripts only
- Do NOT include any <script src="..."> tags that load from non-HTTPS URLs
- Preferred charting library: Chart.js (via CDN: https://cdn.jsdelivr.net/npm/chart.js)`;
}
