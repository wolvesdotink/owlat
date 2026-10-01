import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EditorBlock } from '@owlat/shared';
import { analyzeEmail, getEmailHealthScore } from '../analyzer';
import { validateBlocks } from '../validator';
import { scoreBlockCompatibility } from '../compatibility';
import { renderEmailHtml } from '../renderer';

/**
 * getEmailHealthScore cost bounds (issue #923): one compatibility score per
 * Block, and no repeated validation/analysis when the caller already did both.
 */
vi.mock('../validator', async (importOriginal) => {
	const actual = await importOriginal<{ validateBlocks: typeof validateBlocks }>();
	return { ...actual, validateBlocks: vi.fn(actual.validateBlocks) };
});
vi.mock('../compatibility', async (importOriginal) => {
	const actual = await importOriginal<{
		scoreBlockCompatibility: typeof scoreBlockCompatibility;
	}>();
	return { ...actual, scoreBlockCompatibility: vi.fn(actual.scoreBlockCompatibility) };
});

const blocks: EditorBlock[] = [
	{
		id: 't1',
		type: 'text',
		content: {
			html: '<p>Hello there, this is enough copy to count as text.</p>',
			blockType: 'paragraph',
		},
	},
	{
		id: 'i1',
		type: 'image',
		content: { src: 'https://example.com/a.png', alt: '', width: 100, align: 'center' },
	},
	{
		id: 'b1',
		type: 'button',
		content: { text: 'Go', url: 'https://example.com', backgroundColor: '#000', textColor: '#fff' },
	},
] as unknown as EditorBlock[];

beforeEach(() => {
	vi.clearAllMocks();
});

describe('getEmailHealthScore — shared work', () => {
	const html = renderEmailHtml(blocks);

	it('scores each Block compatibility once across the compatibility and Outlook dimensions', () => {
		vi.clearAllMocks();
		getEmailHealthScore(blocks, html);
		expect(vi.mocked(scoreBlockCompatibility)).toHaveBeenCalledTimes(blocks.length);
		expect(vi.mocked(validateBlocks)).toHaveBeenCalledTimes(1);
	});

	it('reuses a caller validation pass and returns the same score', () => {
		const standalone = getEmailHealthScore(blocks, html);
		// The preview validates without a level; 'soft' only changes `valid`.
		const issues = validateBlocks(blocks, { accessibilityAudit: true }).issues;
		expect(issues).toEqual(
			validateBlocks(blocks, { accessibilityAudit: true, level: 'soft' }).issues
		);
		vi.clearAllMocks();

		const shared = getEmailHealthScore(blocks, html, undefined, {
			analysis: analyzeEmail(html),
			validationIssues: issues,
		});

		expect(vi.mocked(validateBlocks)).not.toHaveBeenCalled();
		expect(shared).toEqual(standalone);
	});

	it('uses the supplied analysis instead of analyzing the html again', () => {
		const analysis = { ...analyzeEmail(html), exceedsGmailClip: true };
		const score = getEmailHealthScore(blocks, html, undefined, { analysis });
		expect(score.recommendations.some((r) => r.message.includes('102KB clip'))).toBe(true);
		expect(getEmailHealthScore(blocks, html).deliverability).toBeGreaterThan(score.deliverability);
	});
});
