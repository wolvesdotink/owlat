import { describe, expect, it } from 'vitest';
import { findDraftGaps, formatDraftGap, hasDraftGaps } from '../answerMode';

describe('draft gaps', () => {
	it('finds each placeholder with its offsets and label', () => {
		const text = 'Hi Jonas, [[attach the September invoice]] and see [[ date ]].';
		expect(findDraftGaps(text)).toEqual([
			{ start: 10, end: 42, label: 'attach the September invoice' },
			{ start: 51, end: 61, label: 'date' },
		]);
		expect(hasDraftGaps(text)).toBe(true);
	});

	it('ignores single brackets, empty and multi-line brackets', () => {
		expect(hasDraftGaps('see [1] and [[ ]] and [[a\nb]]')).toBe(false);
	});

	it('formats a label into a placeholder it can find again', () => {
		const gap = formatDraftGap('the [PO] number\n');
		expect(gap).toBe('[[the  PO  number]]');
		expect(findDraftGaps(gap)[0]?.label).toBe('the  PO  number');
	});
});
