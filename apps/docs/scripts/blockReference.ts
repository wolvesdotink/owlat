/**
 * The generated parts of the block content reference (`2.api/17.blocks.md`,
 * English and German): the field tables and worked examples from the block
 * schema, the column width presets from `getColumnWidths`, and the HTML a
 * text block keeps from the sanitizer's own allow-lists.
 *
 * Each part sits between `<!-- block-reference:<name> -->` and
 * `<!-- /block-reference:<name> -->` in the page; the prose around them is
 * written by hand. The page goes through the repository's oxfmt with its
 * config, as the format gate does, so the check compares what is committed. `bun scripts/blockReference.ts` rewrites the parts,
 * `--check` fails when a page differs from what the sources generate. The
 * docs test runs the same check.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import blockSchema from '@owlat/public-contract/schemas/blocks.json';
import { RAW_HTML_POLICY, TEXT_HTML_POLICY } from '@owlat/email-renderer/sanitize';
import { getColumnWidths } from '@owlat/shared';

type JsonObject = Record<string, unknown>;
type Locale = 'en' | 'de';

export const BLOCK_REFERENCE_PAGE = '2.api/17.blocks.md';
export const pagePath = (locale: Locale): string =>
	fileURLToPath(new URL(`../content/${locale}/${BLOCK_REFERENCE_PAGE}`, import.meta.url));

const WORDS = {
	en: {
		field: 'Field',
		type: 'Type',
		required: 'Required',
		description: 'Description',
		yes: 'yes',
		no: '',
		arrayOf: 'array of',
		oneOf: 'one of',
		ratio: 'Ratio',
		columns: (n: number) => `${n} columns`,
		tag: 'Tag',
		attributes: 'Attributes',
		property: 'Property',
		accepted: 'Value must match',
		allTags: 'every kept tag',
		keptTags: 'Tags kept:',
		schemes: (list: string) => `URLs in \`href\`, \`src\` and \`srcset\` may use ${list}.`,
		schemesByTag: (tag: string, list: string) => `On \`<${tag}>\` they may use ${list} instead.`,
		rawDiff: (tags: string) =>
			`A raw HTML block keeps the same, without ${tags} and without the variable chip attributes on \`<span>\`.`,
		sharedLacking: (list: string) => `Takes the shared fields except ${list}.`,
		sharedAll: 'Takes all the shared fields.',
		example: 'Example:',
	},
	de: {
		field: 'Feld',
		type: 'Typ',
		required: 'Pflicht',
		description: 'Beschreibung',
		yes: 'ja',
		no: '',
		arrayOf: 'Liste von',
		oneOf: 'eins von',
		ratio: 'Verhältnis',
		columns: (n: number) => `${n} Spalten`,
		tag: 'Tag',
		attributes: 'Attribute',
		property: 'Eigenschaft',
		accepted: 'Wert muss passen auf',
		allTags: 'jedes erlaubte Tag',
		keptTags: 'Erlaubte Tags:',
		schemes: (list: string) => `URLs in \`href\`, \`src\` und \`srcset\` dürfen ${list} nutzen.`,
		schemesByTag: (tag: string, list: string) => `Auf \`<${tag}>\` stattdessen ${list}.`,
		rawDiff: (tags: string) =>
			`Ein Raw-HTML-Block behält dasselbe, ohne ${tags} und ohne die Attribute der Variablen-Chips auf \`<span>\`.`,
		sharedLacking: (list: string) => `Nimmt die gemeinsamen Felder außer ${list}.`,
		sharedAll: 'Nimmt alle gemeinsamen Felder.',
		example: 'Beispiel:',
	},
} as const;

const defs = (blockSchema as unknown as { $defs: Record<string, JsonObject> }).$defs;

const code = (value: string) => `\`${value.replace(/\|/g, '\\|')}\``;
const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const list = (values: readonly string[]) => values.map(code).join(', ');

function table(header: string[], rows: string[][]): string {
	return [
		`| ${header.join(' | ')} |`,
		`| ${header.map(() => '---').join(' | ')} |`,
		...rows.map((row) => `| ${row.join(' | ')} |`),
	].join('\n');
}

function typeName(schema: JsonObject, locale: Locale): string {
	const words = WORDS[locale];
	if (typeof schema['$ref'] === 'string') return code(schema['$ref'].replace('#/$defs/', ''));
	if (Array.isArray(schema['enum'])) {
		return (schema['enum'] as unknown[]).map((value) => code(JSON.stringify(value))).join(', ');
	}
	if (schema['type'] === 'array') {
		return `${words.arrayOf} ${typeName(schema['items'] as JsonObject, locale)}`;
	}
	if (Array.isArray(schema['oneOf'])) {
		return `${words.oneOf} ${(schema['oneOf'] as JsonObject[]).map((s) => typeName(s, locale)).join(', ')}`;
	}
	if (schema['type'] === 'object') return code('object');
	return code(String(schema['type']));
}

interface BlockDef {
	type: string;
	name: string;
	description: string;
	content: { properties: Record<string, JsonObject>; required: string[] };
	example: unknown;
}

const blockDefs: BlockDef[] = Object.entries(defs).flatMap(([name, def]) => {
	const properties = def['properties'] as Record<string, JsonObject> | undefined;
	const type = properties?.['type']?.['const'];
	if (typeof type !== 'string') return [];
	const content = properties!['content'] as JsonObject;
	return [
		{
			type,
			name,
			description: String(def['description'] ?? ''),
			content: {
				properties: content['properties'] as Record<string, JsonObject>,
				required: (content['required'] as string[] | undefined) ?? [],
			},
			example: (def['examples'] as unknown[])[0],
		},
	];
});

/**
 * The shared fields: those at least half the block types take. Each is listed
 * once with the type and description most blocks give it.
 */
function sharedFields(): Map<string, JsonObject> {
	const counts = new Map<string, Map<string, { schema: JsonObject; count: number }>>();
	for (const block of blockDefs) {
		for (const [field, schema] of Object.entries(block.content.properties)) {
			const variants = counts.get(field) ?? new Map();
			const key = JSON.stringify(schema);
			const entry = variants.get(key) ?? { schema, count: 0 };
			entry.count += 1;
			variants.set(key, entry);
			counts.set(field, variants);
		}
	}
	const shared = new Map<string, JsonObject>();
	for (const [field, variants] of counts) {
		const total = [...variants.values()].reduce((sum, v) => sum + v.count, 0);
		if (total < blockDefs.length / 2) continue;
		const [common] = [...variants.values()].sort((a, b) => b.count - a.count);
		shared.set(field, common!.schema);
	}
	return shared;
}

function fieldRows(
	properties: Record<string, JsonObject>,
	required: readonly string[],
	locale: Locale
): string[][] {
	const words = WORDS[locale];
	return Object.entries(properties).map(([field, schema]) => [
		code(field),
		typeName(schema, locale),
		required.includes(field) ? words.yes : words.no,
		cell(String(schema['description'] ?? '')),
	]);
}

function fieldTable(
	properties: Record<string, JsonObject>,
	required: readonly string[],
	locale: Locale
): string {
	const words = WORDS[locale];
	return table(
		[words.field, words.type, words.required, words.description],
		fieldRows(properties, required, locale)
	);
}

function sharedFieldsSection(locale: Locale): string {
	return fieldTable(Object.fromEntries(sharedFields()), [], locale);
}

function blockTypesSection(locale: Locale): string {
	const words = WORDS[locale];
	const shared = sharedFields();
	return blockDefs
		.map((block) => {
			const own: Record<string, JsonObject> = {};
			for (const [field, schema] of Object.entries(block.content.properties)) {
				const common = shared.get(field);
				const differs = !common || JSON.stringify(common) !== JSON.stringify(schema);
				if (differs || block.content.required.includes(field)) own[field] = schema;
			}
			const lacking = [...shared.keys()].filter((field) => !(field in block.content.properties));
			return [
				`### ${code(block.type)}`,
				block.description,
				fieldTable(own, block.content.required, locale),
				lacking.length > 0 ? words.sharedLacking(list(lacking)) : words.sharedAll,
				words.example,
				`\`\`\`json\n${JSON.stringify(block.example, null, '\t')}\n\`\`\``,
			].join('\n\n');
		})
		.join('\n\n');
}

function nestedObjectsSection(locale: Locale): string {
	return Object.entries(defs)
		.filter(
			([name, def]) =>
				name !== 'Block' && def['type'] === 'object' && !blockDefs.some((b) => b.name === name)
		)
		.map(([name, def]) =>
			[
				`### ${code(name)}`,
				String(def['description'] ?? ''),
				fieldTable(
					def['properties'] as Record<string, JsonObject>,
					(def['required'] as string[] | undefined) ?? [],
					locale
				),
			]
				.filter(Boolean)
				.join('\n\n')
		)
		.join('\n\n');
}

function columnWidthsSection(locale: Locale): string {
	const words = WORDS[locale];
	const columns = defs['ColumnsBlock']!['properties'] as Record<string, JsonObject>;
	const content = (columns['content'] as JsonObject)['properties'] as Record<string, JsonObject>;
	const ratios = content['ratio']!['enum'] as string[];
	const counts = [2, 3, 4] as const;
	return table(
		[words.ratio, ...counts.map(words.columns)],
		ratios.map((ratio) => [
			code(ratio),
			...counts.map((count) => getColumnWidths(count, ratio).join(' · ')),
		])
	);
}

function textHtmlSection(locale: Locale): string {
	const words = WORDS[locale];
	const policy = TEXT_HTML_POLICY;
	const attributeRows = Object.entries(policy.attributes)
		.filter(([, names]) => names.length > 0)
		.sort(([a], [b]) => (a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b)))
		.map(([tag, names]) => [tag === '*' ? words.allTags : code(`<${tag}>`), list(names)]);
	const styleRows = Object.entries(policy.styles).map(([property, patterns]) => [
		code(property),
		patterns.map(code).join(', '),
	]);
	const textOnly = policy.tags.filter((tag) => !RAW_HTML_POLICY.tags.includes(tag));
	return [
		`${words.keptTags} ${list(policy.tags.map((tag) => `<${tag}>`))}`,
		table([words.tag, words.attributes], attributeRows),
		[
			words.schemes(list(policy.schemes)),
			...Object.entries(policy.schemesByTag).map(([tag, schemes]) =>
				words.schemesByTag(tag, list(schemes))
			),
		].join(' '),
		table([words.property, words.accepted], styleRows),
		words.rawDiff(list(textOnly.map((tag) => `<${tag}>`))),
	].join('\n\n');
}

const SECTIONS: Record<string, (locale: Locale) => string> = {
	'column-widths': columnWidthsSection,
	'text-html': textHtmlSection,
	'shared-fields': sharedFieldsSection,
	'block-types': blockTypesSection,
	'nested-objects': nestedObjectsSection,
};

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function formatted(text: string, locale: Locale): string {
	const result = spawnSync(
		`${ROOT}node_modules/.bin/oxfmt`,
		[
			'--config',
			'oxfmtrc.json',
			`--stdin-filepath=apps/docs/content/${locale}/${BLOCK_REFERENCE_PAGE}`,
		],
		{ cwd: ROOT, input: text, encoding: 'utf8' }
	);
	if (result.status !== 0 || !result.stdout) {
		throw new Error(`oxfmt failed: ${result.stderr || result.error?.message || 'no output'}`);
	}
	return result.stdout;
}

/** `page` with every generated part rewritten, formatted. Throws on a missing marker. */
export function generateBlockReference(page: string, locale: Locale): string {
	let result = page;
	for (const [name, build] of Object.entries(SECTIONS)) {
		const start = `<!-- block-reference:${name} -->`;
		const end = `<!-- /block-reference:${name} -->`;
		const from = result.indexOf(start);
		const to = result.indexOf(end);
		if (from === -1 || to < from) {
			throw new Error(`${BLOCK_REFERENCE_PAGE} (${locale}) lacks the ${name} markers`);
		}
		result = `${result.slice(0, from + start.length)}\n\n${build(locale)}\n\n${result.slice(to)}`;
	}
	return formatted(result, locale);
}

if (import.meta.main) {
	let stale = false;
	for (const locale of ['en', 'de'] as const) {
		const path = pagePath(locale);
		const page = readFileSync(path, 'utf8');
		const generated = generateBlockReference(page, locale);
		if (generated === page) continue;
		if (process.argv.includes('--check')) {
			console.error(
				`content/${locale}/${BLOCK_REFERENCE_PAGE} is out of date. Run \`bun run --cwd apps/docs block-reference\` and commit the result.`
			);
			stale = true;
		} else {
			writeFileSync(path, generated);
			console.info(`Wrote content/${locale}/${BLOCK_REFERENCE_PAGE}`);
		}
	}
	if (stale) process.exit(1);
}
