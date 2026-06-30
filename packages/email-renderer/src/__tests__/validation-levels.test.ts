import { describe, it, expect } from 'vitest';
import { validateBlocks, ValidationError } from '../validator';
import { renderEmailHtml } from '../renderer';
import type { EditorBlock } from '@owlat/shared';

describe('Validation Levels', () => {
	const blockWithError: EditorBlock[] = [
		{
			id: '1',
			type: 'image',
			content: { src: '', alt: 'Photo', width: 100, align: 'center' },
		},
	];

	const validBlocks: EditorBlock[] = [
		{
			id: '1',
			type: 'text',
			content: { html: '<p>Hello</p>', blockType: 'paragraph', fontSize: 16, textColor: '#333' },
		},
	];

	it('default level reports errors as invalid', () => {
		const result = validateBlocks(blockWithError);
		expect(result.valid).toBe(false);
		expect(result.issues.length).toBeGreaterThan(0);
	});

	it('skip level returns valid with no checks', () => {
		const result = validateBlocks(blockWithError, { level: 'skip' });
		expect(result.valid).toBe(true);
		expect(result.issues.length).toBe(0);
	});

	it('soft level always returns valid even with errors', () => {
		const result = validateBlocks(blockWithError, { level: 'soft' });
		expect(result.valid).toBe(true);
		expect(result.issues.length).toBeGreaterThan(0);
		// Issues should still be collected
		expect(result.issues.some((i) => i.severity === 'error')).toBe(true);
	});

	it('strict level throws ValidationError on errors', () => {
		expect(() => {
			validateBlocks(blockWithError, { level: 'strict' });
		}).toThrow(ValidationError);
	});

	it('strict level does not throw when no errors', () => {
		const result = validateBlocks(validBlocks, { level: 'strict' });
		expect(result.valid).toBe(true);
	});

	it('ValidationError contains issues', () => {
		try {
			validateBlocks(blockWithError, { level: 'strict' });
			expect(true).toBe(false); // should not reach here
		} catch (e) {
			expect(e).toBeInstanceOf(ValidationError);
			const ve = e as ValidationError;
			expect(ve.issues.length).toBeGreaterThan(0);
			expect(ve.message).toContain('error');
		}
	});

	describe('renderEmailHtml forwards options.validationLevel', () => {
		it('strict level throws ValidationError when blocks have errors', () => {
			expect(() => renderEmailHtml(blockWithError, { validationLevel: 'strict' })).toThrow(ValidationError);
		});

		it('skip level renders without throwing', () => {
			expect(() => renderEmailHtml(blockWithError, { validationLevel: 'skip' })).not.toThrow();
		});

		it('soft level renders without throwing even with errors', () => {
			expect(() => renderEmailHtml(blockWithError, { validationLevel: 'soft' })).not.toThrow();
		});

		it('default (no level) renders without throwing', () => {
			expect(() => renderEmailHtml(blockWithError)).not.toThrow();
		});
	});
});
