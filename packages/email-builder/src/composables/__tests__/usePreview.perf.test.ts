/**
 * Report-only benchmark of the preview hot path (plan item OW-072): `usePreview`
 * `regenerate` (plain text, Block validation, HTML, analysis, health score;
 * the diff is derived only while the diff panel asks for it) and the dark-mode
 * toggle's `regenerateHtml`, on the canvases in previewCanvasFixtures.ts.
 *
 * The fidelity block always runs: every canvas validates without errors, would
 * fit the one `emailTemplates` document it is saved to, and renders through the
 * same calls the editor makes. The timing block runs only under
 * `bun run perf:bench`, which sets OWLAT_PERF_BENCH_OUT; in CI it is skipped, so
 * no timing is ever asserted.
 */
import { describe, expect, it } from 'vitest';
import { computed, effectScope, ref } from 'vue';
import { renderEmailHtml, renderPlainText, validateBlocks } from '@owlat/email-renderer';
import { GMAIL_CLIP_BYTES } from '@owlat/shared/emailLimits';
import {
	perfBenchOutput,
	sampleTask,
	writeFamilyResult,
} from '../../../../../scripts/perf-bench/sample';
import { defaultTheme } from '../../defaults';
import type { EditorBlock, VariableType } from '../../types';
import { usePreview } from '../usePreview';
import { countBlocks, previewCanvases, type PreviewCanvas } from './previewCanvasFixtures';

/**
 * Convex's document size limit. A template's `content` (the Block JSON),
 * `htmlContent` and `plainTextContent` are columns of one `emailTemplates`
 * document (apps/api/convex/schema/templates.ts), so together they must fit.
 */
const CONVEX_DOCUMENT_BYTES = 1024 * 1024;

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** A preview wired the way EmailBuilder.vue wires it, already in preview mode. */
function openPreview(canvas: PreviewCanvas) {
	const scope = effectScope();
	const canvasBlocks = ref<EditorBlock[]>(canvas.blocks);
	const preview = scope.run(() =>
		usePreview({
			canvasBlocks,
			theme: computed(() => defaultTheme),
			variableType: computed<VariableType>(() => 'personalization'),
			showMandatoryUnsubscribeFooter: computed(() => canvas.marketing),
			renderOptions: ref({}),
			variables: computed(() => [{ key: 'first_name', label: 'First name' }]),
		})
	)!;
	preview.togglePreviewMode();
	let showEdited = false;
	return {
		preview,
		/** An edit, then a regenerate: alternate the canvas so each diff sees new HTML. */
		editAndRegenerate() {
			showEdited = !showEdited;
			canvasBlocks.value = showEdited ? canvas.edited : canvas.blocks;
			preview.regenerate();
			return preview.generatedHtml.value;
		},
		toggleDarkMode() {
			preview.toggleDarkModePreview();
			return preview.generatedHtml.value;
		},
		stop: () => scope.stop(),
	};
}

describe('preview canvas fixture fidelity', () => {
	it.each(previewCanvases().map((c) => [c.name, c] as const))(
		'%s validates, fits its document and renders',
		(_name, canvas) => {
			for (const blocks of [canvas.blocks, canvas.edited]) {
				const errors = validateBlocks(blocks, { accessibilityAudit: true }).issues.filter(
					(issue) => issue.severity === 'error'
				);
				expect(errors).toEqual([]);
				const html = renderEmailHtml(blocks, { theme: defaultTheme });
				const text = renderPlainText(blocks, { theme: defaultTheme });
				expect(bytes(JSON.stringify(blocks)) + bytes(html) + bytes(text)).toBeLessThan(
					CONVEX_DOCUMENT_BYTES
				);
				expect(html).not.toContain('data:image');
			}
			expect(JSON.stringify(canvas.edited)).not.toBe(JSON.stringify(canvas.blocks));
		}
	);

	it('keeps the receipt and the newsletter under the Gmail clip; only the digest is long', () => {
		const htmlBytes = Object.fromEntries(
			previewCanvases().map((c) => [
				c.name,
				bytes(renderEmailHtml(c.blocks, { theme: defaultTheme })),
			])
		);
		expect(htmlBytes['receipt']).toBeLessThan(GMAIL_CLIP_BYTES);
		expect(htmlBytes['newsletter']).toBeLessThan(GMAIL_CLIP_BYTES);
		expect(htmlBytes['digest']).toBeGreaterThan(GMAIL_CLIP_BYTES);
	});

	it('builds the same canvases on every call', () => {
		expect(JSON.stringify(previewCanvases())).toBe(JSON.stringify(previewCanvases()));
	});

	it('runs the full preview on every regenerate and diffs against the previous render', () => {
		const canvas = previewCanvases()[1]!;
		const open = openPreview(canvas);
		open.editAndRegenerate();
		expect(open.preview.generatedHtml.value).toContain('Updated after launch.');
		expect(open.preview.plainText.value).not.toContain('{{first_name}}');
		expect(open.preview.emailAnalysis.value).not.toBeNull();
		expect(open.preview.healthScore.value).not.toBeNull();
		// The diff is derived on request (the diff panel sets diffRequested), so a
		// regenerate alone does not pay for it; opening the panel diffs the pair.
		expect(open.preview.emailDiff.value).toBeNull();
		open.preview.diffRequested.value = true;
		expect(open.preview.emailDiff.value).not.toBeNull();
		expect(open.preview.emailDiff.value!.identical).toBe(false);
		// AMP is rendered only on request, so the benchmark leaves it out too.
		expect(open.preview.ampHtml.value).toBe('');
		open.toggleDarkMode();
		expect(open.preview.previewDarkMode.value).toBe(true);
		open.stop();
	});
});

const output = perfBenchOutput();

describe.runIf(output)('preview regenerate benchmark (perf:bench only)', () => {
	it('samples regenerate and the dark-mode toggle', () => {
		const canvases = previewCanvases();
		const tasks = canvases.map((canvas) => {
			const open = openPreview(canvas);
			const task = sampleTask(`regenerate after an edit, ${canvas.name}`, open.editAndRegenerate, {
				warmup: 10,
				samples: canvas.name === 'digest' ? 30 : 60,
				opsPerSample: 1,
			});
			open.stop();
			return task;
		});
		const newsletter = canvases.find((c) => c.name === 'newsletter')!;
		const open = openPreview(newsletter);
		tasks.push(
			sampleTask('dark-mode toggle (regenerateHtml), newsletter', open.toggleDarkMode, {
				warmup: 10,
				samples: 60,
				opsPerSample: 1,
			})
		);
		open.stop();

		const describeCanvas = (canvas: PreviewCanvas) => {
			const html = renderEmailHtml(canvas.blocks, { theme: defaultTheme });
			const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
			return (
				`${canvas.blocks.length} top-level Blocks, ${countBlocks(canvas.blocks)} counting column items, ` +
				`${kib(bytes(JSON.stringify(canvas.blocks)))} Block JSON, ${kib(bytes(html))} HTML ` +
				`(Gmail clips above ${kib(GMAIL_CLIP_BYTES)})`
			);
		};
		writeFamilyResult(output!, {
			family: 'preview-regenerate',
			title: 'usePreview regenerate and dark-mode toggle',
			dataset: {
				'call site':
					'EmailBuilder.vue preview (packages/email-builder/src/composables/usePreview.ts)',
				...Object.fromEntries(canvases.map((c) => [c.name, describeCanvas(c)])),
				blocks:
					'createBlock / createColumnItem defaults, image URLs (no data URIs), personalization tokens',
				'edit model': 'each regenerate alternates the canvas with its one-paragraph-edited twin',
				fixture: 'packages/email-builder/src/composables/__tests__/previewCanvasFixtures.ts',
			},
			tasks,
		});
		expect(tasks).toHaveLength(canvases.length + 1);
	});
});
