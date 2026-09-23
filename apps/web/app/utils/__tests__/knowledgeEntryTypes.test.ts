/**
 * The web presentation map for knowledge entries has to cover every entry type
 * and source the backend can store. It once knew seven of the nine types, so
 * policy and FAQ entries (canonical answers) rendered with an empty circle, had
 * no filter tab and showed their source as the raw value "curated" (#805).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';
import {
	AUTHORABLE_ENTRY_TYPES,
	AUTHORABLE_SOURCE_TYPES,
	ENTRY_TYPES,
	SOURCE_CONFIG,
	TYPE_CONFIG,
	entryTypeIcon,
	sourceIcon,
	sourceLabel,
} from '../knowledgeEntryTypes';

const schema = readFileSync(
	resolve(__dirname, '../../../../api/convex/schema/knowledge.ts'),
	'utf8'
);

function literalsIn(source: string): string[] {
	return [...source.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
}

const backendEntryTypes = literalsIn(
	/export const ENTRY_TYPES = \[([\s\S]*?)\] as const/.exec(schema)![1]!
);
const backendSourceTypes = [
	.../export const sourceTypeValidator = v\.union\(([\s\S]*?)\n\);/
		.exec(schema)![1]!
		.matchAll(/v\.literal\('([a-z_]+)'\)/g),
].map((match) => match[1]!);

type Catalog = Record<string, unknown>;
const at = (catalog: Catalog, path: string): Record<string, string> =>
	path.split('.').reduce<unknown>((node, key) => (node as Catalog)[key], catalog) as Record<
		string,
		string
	>;

const ENTRY_TYPE_LABEL_MAPS = [
	'dashboard.knowledge.index.entryTypes',
	'dashboard.knowledge.detail.entryTypes',
	'components.knowledge.graphView.entryTypes',
	'components.knowledge.knowledgeEntryCard.entryTypes',
	'components.knowledge.knowledgeEntryForm.entryTypes',
	'components.knowledge.relationsList.entryTypes',
];
const SOURCE_LABEL_MAPS = [
	'dashboard.knowledge.detail.sourceTypes',
	'components.knowledge.knowledgeEntryCard.sourceTypes',
	'components.knowledge.knowledgeEntryForm.sourceTypes',
];

describe('knowledge entry type map', () => {
	it('knows every entry type the backend stores', () => {
		expect(backendEntryTypes).toContain('policy');
		expect([...ENTRY_TYPES].sort()).toEqual([...backendEntryTypes].sort());
	});

	it('gives every type a real icon', () => {
		for (const type of ENTRY_TYPES) {
			expect(entryTypeIcon(type), type).not.toBe('lucide:circle');
			expect(TYPE_CONFIG[type].label, type).toBeTruthy();
		}
	});

	it('knows every source the backend stores', () => {
		expect(backendSourceTypes).toContain('curated');
		expect(Object.keys(SOURCE_CONFIG).sort()).toEqual([...backendSourceTypes].sort());
		for (const source of backendSourceTypes) {
			expect(sourceIcon(source), source).not.toBe('lucide:circle');
		}
	});

	it('calls a curated source a canonical answer', () => {
		expect(sourceLabel('curated')).toBe('Canonical answer');
	});

	it('keeps canonical-answer types and the curated source out of the generic entry form', () => {
		expect(AUTHORABLE_ENTRY_TYPES).not.toContain('policy');
		expect(AUTHORABLE_ENTRY_TYPES).not.toContain('faq');
		expect(AUTHORABLE_ENTRY_TYPES).toHaveLength(7);
		expect(AUTHORABLE_SOURCE_TYPES).not.toContain('curated');
	});

	it.each([
		['en', en],
		['de', de],
	])('has a %s label for every type and source on every knowledge surface', (_lang, catalog) => {
		for (const path of ENTRY_TYPE_LABEL_MAPS) {
			const labels = at(catalog as Catalog, path);
			for (const type of ENTRY_TYPES) expect(labels[type], `${path}.${type}`).toBeTruthy();
		}
		for (const path of SOURCE_LABEL_MAPS) {
			const labels = at(catalog as Catalog, path);
			for (const source of backendSourceTypes) {
				expect(labels[source], `${path}.${source}`).toBeTruthy();
			}
		}
	});
});
