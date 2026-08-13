import { describe, it, expect } from 'vitest';
import { buildFileSearchableText } from '../fileSearchText';

describe('buildFileSearchableText', () => {
	it('folds tags, auto-tags, summary and extracted text into one payload', () => {
		const text = buildFileSearchableText({
			filename: 'contract.pdf',
			title: 'Acme MSA',
			summary: 'Master services agreement with Acme.',
			tags: ['legal', 'acme'],
			autoTags: ['contract'],
			extractedText: 'Payment terms are net 30 days.',
		});

		for (const needle of [
			'contract.pdf',
			'Acme MSA',
			'Master services agreement',
			'legal',
			'acme',
			'net 30 days',
		]) {
			expect(text).toContain(needle);
		}
	});

	it('emits the filename words separately so a mid-name token is findable', () => {
		const text = buildFileSearchableText({ filename: 'q3-budget_v2.final.xlsx' });
		expect(text.split(' ')).toContain('budget');
	});

	it('de-duplicates repeats case-insensitively', () => {
		const text = buildFileSearchableText({
			filename: 'invoice.pdf',
			title: 'Invoice',
			tags: ['invoice', 'INVOICE'],
		});
		expect(
			text
				.toLowerCase()
				.split(' ')
				.filter((w) => w === 'invoice')
		).toHaveLength(1);
	});

	it('drops empty parts instead of emitting blank gaps', () => {
		const text = buildFileSearchableText({
			filename: 'notes.txt',
			title: '   ',
			tags: ['', ' '],
		});
		expect(text).toBe('notes.txt notes');
	});

	it('caps the extracted body so a huge document cannot eat the whole budget', () => {
		const text = buildFileSearchableText({
			filename: 'huge.txt',
			extractedText: 'x'.repeat(20000),
		});
		expect(text.split(' ').find((part) => part.startsWith('x'))).toHaveLength(1000);
	});

	it('caps the whole payload', () => {
		const text = buildFileSearchableText({
			filename: 'huge.txt',
			summary: 'y'.repeat(20000),
			extractedText: 'x'.repeat(20000),
		});
		expect(text).toHaveLength(5000);
	});
});
