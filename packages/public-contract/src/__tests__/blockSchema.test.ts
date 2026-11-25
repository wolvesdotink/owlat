import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BLOCK_EXAMPLES } from '../../scripts/blockExamples';
import { buildBlockContentSchema } from '../../scripts/blockSchemaSource';

type JsonObject = Record<string, unknown>;

const committed = JSON.parse(
	readFileSync(new URL('../../schemas/blocks.json', import.meta.url), 'utf8')
) as JsonObject;
const generated = buildBlockContentSchema();
const defs = generated['$defs'] as Record<string, JsonObject>;

const blockDef = (type: string): JsonObject => {
	const found = Object.values(defs).find(
		(def) =>
			(def['properties'] as JsonObject | undefined)?.['type'] !== undefined &&
			(def['properties'] as Record<string, JsonObject>)['type']!['const'] === type
	);
	if (!found) throw new Error(`no $defs entry for ${type}`);
	return found;
};
const contentOf = (type: string) =>
	(blockDef(type)['properties'] as Record<string, JsonObject>)['content']!;

describe('schemas/blocks.json', () => {
	it('is what the block types generate', () => {
		expect(committed).toEqual(generated);
	});

	it('is the same document on every build', () => {
		expect(JSON.stringify(buildBlockContentSchema())).toBe(JSON.stringify(generated));
	});

	it('is JSON Schema 2020-12 with one $defs entry per block type, chosen by `type`', () => {
		expect(generated['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
		const block = defs['Block']!;
		const types = Object.keys(BLOCK_EXAMPLES);
		expect((block['properties'] as Record<string, JsonObject>)['type']!['enum']).toEqual(types);
		expect((block['oneOf'] as unknown[]).length).toBe(types.length);
		for (const type of types) expect(blockDef(type)).toBeDefined();
	});

	it('carries each block type’s worked example', () => {
		for (const [type, example] of Object.entries(BLOCK_EXAMPLES)) {
			expect(blockDef(type)['examples']).toEqual([example]);
		}
	});
});

describe('what the generator reads from the types', () => {
	it('requires a field the types require and leaves an optional one out', () => {
		const button = contentOf('button');
		expect(button['required']).toEqual(
			expect.arrayContaining(['text', 'url', 'backgroundColor', 'align'])
		);
		expect(button['required']).not.toContain('fontSize');
	});

	it('leaves out a required field whose doc comment says the write accepts it missing', () => {
		const required = contentOf('container')['required'] as string[];
		expect(required).toContain('paddingTop');
		for (const field of [
			'paddingLinked',
			'marginTop',
			'marginRight',
			'marginBottom',
			'marginLeft',
		]) {
			expect(required).not.toContain(field);
		}
	});

	it('turns literal unions into enums', () => {
		const columns = contentOf('columns')['properties'] as Record<string, JsonObject>;
		expect(columns['ratio']!['enum']).toEqual([
			'equal',
			'left-wide',
			'right-wide',
			'left-narrow',
			'right-narrow',
		]);
		expect(columns['columnCount']).toMatchObject({ type: 'integer', enum: [1, 2, 3, 4] });
		const social = contentOf('social')['properties'] as Record<string, JsonObject>;
		expect(social['iconStyle']!['enum']).toEqual(['filled', 'outline']);
	});

	it('lets columns hold text, image, button, divider and spacer, and containers more', () => {
		const refs = (name: string) =>
			(defs[name]!['oneOf'] as Array<{ $ref: string }>).map((entry) => entry.$ref);
		expect(refs('ColumnItem')).toEqual(
			['TextBlock', 'ImageBlock', 'ButtonBlock', 'DividerBlock', 'SpacerBlock'].map(
				(name) => `#/$defs/${name}`
			)
		);
		expect(refs('ContainerItem')).toEqual(
			[
				'TextBlock',
				'ImageBlock',
				'ButtonBlock',
				'DividerBlock',
				'SpacerBlock',
				'ColumnsBlock',
				'SocialBlock',
				'ContainerBlock',
			].map((name) => `#/$defs/${name}`)
		);
	});

	it('describes a shared field once, from CommonBlockProperties, where the block has no comment of its own', () => {
		const text = contentOf('text')['properties'] as Record<string, JsonObject>;
		expect(text['marginTop']!['description']).toBe('Space outside the block, in px.');
	});

	it('refuses fields a block does not list', () => {
		for (const type of Object.keys(BLOCK_EXAMPLES)) {
			expect(blockDef(type)['additionalProperties']).toBe(false);
			expect(contentOf(type)['additionalProperties']).toBe(false);
		}
	});
});
