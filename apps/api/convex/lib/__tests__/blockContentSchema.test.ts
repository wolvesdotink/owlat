/**
 * The published JSON Schema of block content
 * (`@owlat/public-contract/schemas/blocks.json`) against what this server
 * accepts and stores:
 *
 * - every stored block in the renderer's corpus and every demo seed template,
 *   as a write stores it (`sanitizeStoredBlocksJson`, then the readers' id and
 *   envelope normalisation), is valid under the schema;
 * - deliberately wrong blocks are not;
 * - each block type's worked example is valid and renders;
 * - a field the schema requires is one whose absence the renderer's validator
 *   or render refuses, and the other way round;
 * - which block types the schema lets sit in columns and containers is what the
 *   renderer's Block modules accept at those placements.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import blockSchema from '@owlat/public-contract/schemas/blocks.json';
import { moduleFor, renderEmailHtml, validateBlocks } from '@owlat/email-renderer';
import type { BlockType, EditorBlock } from '@owlat/shared';
import { describe, expect, it } from 'vitest';
import { parseContentBlocks } from '../../emailBlocks/consumers';
import { sanitizeStoredBlocksJson } from '../emailContentSanitize';

type JsonObject = Record<string, unknown>;

const CONVEX_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = resolve(
	CONVEX_ROOT,
	'../../../packages/email-renderer/src/__tests__/storedBlocks'
);
const SEED_DIR = join(CONVEX_ROOT, 'seedDemo', 'fixtures');

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(blockSchema);

const defs = (blockSchema as { $defs: Record<string, JsonObject> }).$defs;
const blockDefs = Object.values(defs).filter(
	(def) => (def['properties'] as Record<string, JsonObject> | undefined)?.['type']?.['const']
);
const typeOf = (def: JsonObject) =>
	(def['properties'] as Record<string, JsonObject>)['type']!['const'] as BlockType;
const contentOf = (def: JsonObject) =>
	(def['properties'] as Record<string, JsonObject>)['content']!;
const EXAMPLES = blockDefs.map((def) => (def['examples'] as EditorBlock[])[0]!);

function schemaErrors(blocks: unknown): string {
	return validate(blocks)
		? ''
		: ajv.errorsText(validate.errors?.filter((e) => e.keyword !== 'oneOf'));
}

/**
 * The blocks a write of `json` stores, as every reader parses them. The cast
 * bridges the two import paths of `EditorBlock` (`@owlat/shared` and its
 * `/types` subpath), which TypeScript treats as different types.
 */
const storedBlocks = (json: string): EditorBlock[] =>
	parseContentBlocks(sanitizeStoredBlocksJson(json)) as unknown as EditorBlock[];

describe('stored content is valid under the schema', () => {
	const corpus = readdirSync(CORPUS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
		.flatMap((dir) =>
			readdirSync(join(CORPUS_DIR, dir.name))
				.filter((file) => file.endsWith('.json'))
				.map((file) => {
					const raw = JSON.parse(readFileSync(join(CORPUS_DIR, dir.name, file), 'utf8')) as {
						stored: unknown;
					};
					return { name: `${dir.name}/${file}`, json: JSON.stringify(raw.stored) };
				})
		);

	/**
	 * Fixtures that record a row the editor stored although the validator
	 * refuses it. The schema must refuse them too.
	 */
	const REFUSED_BY_VALIDATOR: Record<string, string> = {
		'v1/template-numeric-strings.json':
			'the button paddingY "wide", which the write drops, leaving a required field missing',
	};

	it.each(corpus)('corpus $name', ({ name, json }) => {
		const blocks = storedBlocks(json);
		expect(blocks.length).toBeGreaterThan(0);
		const validatorRefuses = validateBlocks(blocks).issues.some((i) => i.severity === 'error');
		expect(validatorRefuses).toBe(name in REFUSED_BY_VALIDATOR);
		if (validatorRefuses) expect(validate(blocks)).toBe(false);
		else expect(schemaErrors(blocks)).toBe('');
	});

	const seeds = ['emailTemplates', 'transactionalEmails', 'savedBlocks'].flatMap((table) => {
		const records = JSON.parse(readFileSync(join(SEED_DIR, `${table}.json`), 'utf8')) as Array<{
			name: string;
			content: string;
		}>;
		return records.map((record) => ({ name: `${table}: ${record.name}`, json: record.content }));
	});

	it.each(seeds)('seed $name', ({ json }) => {
		const blocks = storedBlocks(json);
		expect(blocks.length).toBeGreaterThan(0);
		expect(schemaErrors(blocks)).toBe('');
	});
});

describe('wrong blocks are not valid', () => {
	const text = EXAMPLES.find((b) => b.type === 'text')!;
	const columns = EXAMPLES.find((b) => b.type === 'columns')!;
	const container = EXAMPLES.find((b) => b.type === 'container')!;
	const hero = EXAMPLES.find((b) => b.type === 'hero')!;
	const button = EXAMPLES.find((b) => b.type === 'button')!;
	const image = EXAMPLES.find((b) => b.type === 'image')!;
	const social = EXAMPLES.find((b) => b.type === 'social')!;
	const withContent = (block: EditorBlock, content: JsonObject) => ({
		...block,
		content: { ...block.content, ...content },
	});
	const withoutField = (block: EditorBlock, field: string) => {
		const content: JsonObject = { ...block.content };
		delete content[field];
		return { ...block, content };
	};

	it.each([
		['an unknown block type', { id: 'x', type: 'banner', content: {} }],
		['a block without content', { id: 'x', type: 'spacer' }],
		['a block without an id', { type: text.type, content: text.content }],
		['a button without its url', withoutField(button, 'url')],
		['a font size written as a CSS length', withContent(text, { fontSize: '16px' })],
		['an alignment outside the enum', withContent(image, { align: 'middle' })],
		['a misspelled field', withContent(text, { colour: '#000000' })],
		['six columns', withContent(columns, { columnCount: 6 })],
		['a column ratio that is not a preset', withContent(columns, { ratio: 'two-thirds' })],
		['a container inside a column', withContent(columns, { columns: [[container], []] })],
		['a hero inside a container', withContent(container, { items: [hero] })],
		[
			'a social link to an unknown platform',
			withContent(social, {
				links: [{ platform: 'myspace', url: 'https://example.com', enabled: true }],
			}),
		],
	])('%s', (_name, wrong) => {
		expect(validate([wrong])).toBe(false);
	});

	it('a single block instead of a list of blocks', () => {
		expect(validate(text)).toBe(false);
	});
});

describe('the worked examples', () => {
	it('cover every block type the renderer registers', () => {
		expect(EXAMPLES.map((b) => b.type).sort()).toEqual(blockDefs.map(typeOf).sort());
		for (const example of EXAMPLES) expect(moduleFor(example.type)).toBeDefined();
	});

	it.each(EXAMPLES.map((b) => [b.type, b] as const))(
		'%s is valid and renders',
		(_type, example) => {
			expect(schemaErrors([example])).toBe('');
			const warnings: string[] = [];
			const html = renderEmailHtml([example], { onWarning: (w) => warnings.push(w) });
			expect(html).toContain(`data-block-id="${example.id}"`);
			expect(warnings.filter((w) => w.startsWith('Block validation'))).toEqual([]);
			expect(validateBlocks([example]).issues.filter((i) => i.severity === 'error')).toEqual([]);
		}
	);
});

/** Whether the write path refuses `block`: a validator error for it, or a throw. */
function refused(block: EditorBlock): boolean {
	try {
		const { issues } = validateBlocks([block]);
		if (issues.some((i) => i.severity === 'error' && i.blockId === block.id)) return true;
		renderEmailHtml([block]);
		return false;
	} catch {
		return true;
	}
}

describe('required fields agree with the validator', () => {
	it.each(EXAMPLES.map((b) => [b.type, b] as const))(
		'%s: a field is required exactly when the write refuses the block without it',
		(type, example) => {
			const def = blockDefs.find((d) => typeOf(d) === type)!;
			const required = new Set((contentOf(def)['required'] as string[] | undefined) ?? []);
			const disagreements: string[] = [];
			for (const field of Object.keys(example.content)) {
				const content: JsonObject = { ...example.content };
				delete content[field];
				const isRefused = refused({ ...example, content } as unknown as EditorBlock);
				if (isRefused !== required.has(field)) {
					disagreements.push(
						`${field}: schema ${required.has(field) ? 'requires' : 'allows leaving out'}, write ${isRefused ? 'refuses' : 'accepts'}`
					);
				}
			}
			for (const field of required) {
				expect(Object.keys(example.content), `${type} example lacks ${field}`).toContain(field);
			}
			expect(disagreements).toEqual([]);
		}
	);
});

describe('nesting follows the Block modules', () => {
	const allowedIn = (itemDef: string) =>
		(defs[itemDef]!['oneOf'] as Array<{ $ref: string }>).map(({ $ref }) =>
			typeOf(defs[$ref.replace('#/$defs/', '')]!)
		);

	it.each([
		['ColumnItem', 'column'],
		['ContainerItem', 'container'],
	] as const)('%s holds the block types that render at the %s placement', (itemDef, placement) => {
		const accepted = blockDefs
			.map(typeOf)
			.filter((type) => (moduleFor(type)?.placements ?? ['root']).includes(placement));
		expect(allowedIn(itemDef).sort()).toEqual(accepted.sort());
	});
});
