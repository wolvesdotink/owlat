import { describe, it, expect } from 'vitest';
import { getSchema, getAllSchemas } from '../index';

const ALL_BLOCK_TYPES = [
	'text', 'image', 'button', 'divider', 'spacer',
	'columns', 'social', 'container', 'hero', 'table',
	'rawHtml', 'video', 'accordion', 'menu', 'carousel',
	'list', 'progressBar',
];

describe('schema registry', () => {
	describe('registration', () => {
		it('registers schemas for all 17 block types', () => {
			const schemas = getAllSchemas();
			expect(schemas).toHaveLength(17);
		});

		it('each schema has the correct type matching its block', () => {
			for (const type of ALL_BLOCK_TYPES) {
				const schema = getSchema(type);
				expect(schema).toBeDefined();
				expect(schema!.type).toBe(type);
			}
		});
	});

	describe('getSchema', () => {
		it('returns undefined for unknown block type', () => {
			expect(getSchema('nonexistent')).toBeUndefined();
		});

		it('returns a schema with required properties', () => {
			const schema = getSchema('text')!;
			expect(schema.type).toBe('text');
			expect(schema.label).toBe('Text');
			expect(schema.groups).toBeInstanceOf(Array);
			expect(schema.groups.length).toBeGreaterThan(0);
		});
	});

	describe('schema structure', () => {
		it('each schema has at least one property group', () => {
			for (const type of ALL_BLOCK_TYPES) {
				const schema = getSchema(type)!;
				expect(schema.groups.length).toBeGreaterThan(0);
			}
		});

		it('each group has a label and fields array', () => {
			for (const type of ALL_BLOCK_TYPES) {
				const schema = getSchema(type)!;
				for (const group of schema.groups) {
					expect(group.label).toBeTruthy();
					expect(group.fields).toBeInstanceOf(Array);
				}
			}
		});

		it('each field has key, label, and type', () => {
			for (const type of ALL_BLOCK_TYPES) {
				const schema = getSchema(type)!;
				for (const group of schema.groups) {
					for (const field of group.fields) {
						expect(field.key).toBeTruthy();
						expect(field.label).toBeTruthy();
						expect(field.type).toBeTruthy();
					}
				}
			}
		});

		it('field keys are unique within each group', () => {
			for (const type of ALL_BLOCK_TYPES) {
				const schema = getSchema(type)!;
				for (const group of schema.groups) {
					const keys = group.fields.map((f) => f.key);
					const uniqueKeys = new Set(keys);
					expect(keys.length).toBe(uniqueKeys.size);
				}
			}
		});
	});

	describe('specific schemas', () => {
		it('text schema has content and typography groups', () => {
			const schema = getSchema('text')!;
			const groupLabels = schema.groups.map((g) => g.label);
			expect(groupLabels).toContain('Content');
			expect(groupLabels).toContain('Typography');
		});

		it('image schema has a src field of type image', () => {
			const schema = getSchema('image')!;
			const allFields = schema.groups.flatMap((g) => g.fields);
			const srcField = allFields.find((f) => f.key === 'src');
			expect(srcField).toBeDefined();
			expect(srcField!.type).toBe('image');
		});

		it('button schema has text and url fields', () => {
			const schema = getSchema('button')!;
			const allFields = schema.groups.flatMap((g) => g.fields);
			const textField = allFields.find((f) => f.key === 'text');
			const urlField = allFields.find((f) => f.key === 'url');
			expect(textField).toBeDefined();
			expect(urlField).toBeDefined();
			expect(urlField!.type).toBe('url');
		});

		it('social platform options are derived from SOCIAL_PLATFORMS (17 entries, twitter editor label)', () => {
			const schema = getSchema('social')!;
			const allFields = schema.groups.flatMap((g) => g.fields);
			const linksField = allFields.find((f) => f.key === 'links')!;
			const platformField = linksField.itemSchema!.find((f) => f.key === 'platform')!;
			expect(platformField.options).toHaveLength(17);
			const twitter = platformField.options!.find((o) => o.value === 'twitter');
			expect(twitter!.label).toBe('Twitter / X');
			const facebook = platformField.options!.find((o) => o.value === 'facebook');
			expect(facebook!.label).toBe('Facebook');
		});

		it('number fields have min/max constraints', () => {
			const schema = getSchema('text')!;
			const allFields = schema.groups.flatMap((g) => g.fields);
			const fontSizeField = allFields.find((f) => f.key === 'fontSize');
			if (fontSizeField) {
				expect(fontSizeField.type).toBe('number');
				expect(fontSizeField.min).toBeDefined();
				expect(fontSizeField.max).toBeDefined();
			}
		});

		it('select fields have options', () => {
			for (const type of ALL_BLOCK_TYPES) {
				const schema = getSchema(type)!;
				const allFields = schema.groups.flatMap((g) => g.fields);
				const selectFields = allFields.filter((f) => f.type === 'select');
				for (const field of selectFields) {
					expect(field.options).toBeDefined();
					expect(field.options!.length).toBeGreaterThan(0);
					for (const opt of field.options!) {
						expect(opt.label).toBeTruthy();
						expect(opt.value).toBeDefined();
					}
				}
			}
		});

		it('showWhen conditionals reference valid field keys', () => {
			for (const type of ALL_BLOCK_TYPES) {
				const schema = getSchema(type)!;
				const allFields = schema.groups.flatMap((g) => g.fields);
				const allKeys = new Set(allFields.map((f) => f.key));
				const conditionalFields = allFields.filter((f) => f.showWhen);
				for (const field of conditionalFields) {
					expect(allKeys.has(field.showWhen!.key)).toBe(true);
				}
			}
		});
	});
});
