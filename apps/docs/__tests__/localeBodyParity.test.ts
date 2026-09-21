import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONTENT_ROOT = resolve(import.meta.dirname, '../content');

function markdownFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? markdownFiles(path) : path.endsWith('.md') ? [path] : [];
	});
}

function structure(body: string) {
	const headings = [...body.matchAll(/^(#{1,6})\s+/gm)].map((match) => match[1]!.length).join('');
	const fences = [...body.matchAll(/^```([^\s`]*)/gm)].map((match) => match[1] || 'plain');
	const tables: string[] = [];
	const lines = body.split('\n');
	for (let index = 0; index < lines.length; index += 1) {
		if (
			!/^\s*\|.*\|\s*$/.test(lines[index] ?? '') ||
			!/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(lines[index + 1] ?? '')
		) {
			continue;
		}
		let rows = 2;
		const columns = lines[index]!.match(/\|/g)!.length - 1;
		while (/^\s*\|.*\|\s*$/.test(lines[index + rows] ?? '')) rows += 1;
		tables.push(`${rows}x${columns}`);
		index += rows - 1;
	}
	return { headings, fences, tables };
}

function operatorSymbols(body: string): string[] {
	return [
		...new Set(
			[...body.matchAll(/`([^`\n]+)`/g)]
				.map((match) => match[1]!.trim())
				.filter(
					(value) =>
						/^[A-Z][A-Z0-9_]*$/.test(value) ||
						/^(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+\/\S+$/.test(value)
				)
		),
	].sort();
}

function difference(left: string[], right: string[]): string[] {
	return left.filter((value) => !right.includes(value));
}

const englishRoot = resolve(CONTENT_ROOT, 'en');
const pairs = markdownFiles(englishRoot).map((englishPath) => {
	const path = relative(englishRoot, englishPath);
	return {
		path,
		english: readFileSync(englishPath, 'utf8'),
		german: readFileSync(resolve(CONTENT_ROOT, 'de', path), 'utf8'),
	};
});

/**
 * Existing translation debt is recorded explicitly so this suite is a ratchet:
 * a new mismatch fails, while fixing one requires deleting its baseline here.
 * Decision-plane rows were added equally to EN and DE; their table sizes below
 * include those rows without increasing the pre-existing translation difference.
 */
const knownStructureDrift = {
	'1.guide/23.feature-flags.md': {
		en: {
			headings: '123311322222',
			fences: ['sh', 'plain', 'sh', 'plain'],
			tables: ['5x3', '9x3', '35x4'],
		},
		de: {
			headings: '123311322222',
			fences: ['sh', 'plain', 'sh', 'plain'],
			tables: ['5x3', '8x3', '34x4'],
		},
	},
	'1.guide/29.team-inbox.md': {
		en: { headings: '22332332233222222', fences: [], tables: ['10x2', '6x2', '6x2'] },
		de: { headings: '223323322222222', fences: [], tables: ['10x2', '6x2', '6x2'] },
	},
	'1.guide/30.ai-agent.md': {
		en: { headings: '232333333222222', fences: [], tables: ['5x3', '8x2', '5x3', '7x2'] },
		de: { headings: '23233333222222', fences: [], tables: ['5x3', '8x2', '5x3', '7x2'] },
	},
	'1.guide/34.code-tasks.md': {
		en: { headings: '22223333322', fences: [], tables: ['8x3', '8x2', '16x2'] },
		de: { headings: '22223333322', fences: [], tables: ['8x3', '8x2', '13x2'] },
	},
	'1.guide/52.secure-email.md': {
		en: { headings: '223222333333222', fences: [], tables: ['6x3', '8x3'] },
		de: { headings: '22322233333222', fences: [], tables: ['6x3', '8x3'] },
	},
	'3.developer/11.feature-flags.md': {
		en: {
			headings: '122222222',
			fences: ['ts', 'plain', 'ts', 'plain', 'plain', 'plain', 'ts', 'plain'],
			tables: ['10x2', '9x2'],
		},
		de: {
			headings: '122222222',
			fences: ['ts', 'plain', 'ts', 'plain', 'plain', 'plain', 'ts', 'plain'],
			tables: ['9x2', '9x2'],
		},
	},
	'3.developer/5.authentication.md': {
		en: {
			headings: '22233233233333232332',
			fences: [
				'typescript',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
				'vue',
				'plain',
				'vue',
				'plain',
				'vue',
				'plain',
				'vue',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
			],
			tables: ['7x3', '11x2'],
		},
		de: {
			headings: '2223323323333232332',
			fences: [
				'typescript',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
				'vue',
				'plain',
				'vue',
				'plain',
				'vue',
				'plain',
				'vue',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
				'typescript',
				'plain',
			],
			tables: ['7x3', '11x2'],
		},
	},
	'3.developer/8.environment-variables.md': {
		en: {
			headings: '23333311111113113113111111111143111111134333223343433344343233233323312222233332',
			fences: [
				'sh',
				'plain',
				'sh',
				'plain',
				'sh',
				'plain',
				'sh',
				'plain',
				'sh',
				'plain',
				'sh',
				'plain',
				'bash',
				'plain',
				'sh',
				'plain',
				'bash',
				'plain',
				'bash',
				'plain',
				'bash',
				'plain',
				'bash',
				'plain',
				'bash',
				'plain',
				'bash',
				'plain',
			],
			tables: [
				'7x3',
				'6x3',
				'18x3',
				'5x3',
				'4x3',
				'6x3',
				'4x2',
				'4x2',
				'5x3',
				'6x2',
				'32x3',
				'8x5',
				'7x2',
				'4x2',
				'4x2',
				'7x2',
				'6x2',
				'3x2',
				'5x2',
				'7x3',
				'4x2',
				'4x3',
				'4x2',
				'4x2',
				'11x3',
				'14x3',
				'4x3',
				'5x2',
				'76x5',
				'8x5',
				'5x5',
				'14x5',
			],
		},
		de: {
			headings: '2333331111111311311311111111114311111113433223343433344343233233323312222233332',
			fences: [
				'sh',
				'plain',
				'sh',
				'plain',
				'sh',
				'plain',
				'sh',
				'plain',
				'sh',
				'plain',
				'sh',
				'plain',
				'bash',
				'plain',
				'sh',
				'plain',
				'bash',
				'plain',
				'bash',
				'plain',
				'bash',
				'plain',
				'bash',
				'plain',
				'bash',
				'plain',
				'bash',
				'plain',
			],
			tables: [
				'7x3',
				'6x3',
				'18x3',
				'5x3',
				'4x3',
				'6x3',
				'4x2',
				'4x2',
				'6x2',
				'29x3',
				'8x5',
				'7x2',
				'4x2',
				'4x2',
				'7x2',
				'6x2',
				'3x2',
				'5x2',
				'7x3',
				'4x2',
				'4x3',
				'4x2',
				'4x2',
				'11x3',
				'14x3',
				'4x3',
				'5x2',
				'76x5',
				'8x5',
				'5x5',
				'14x5',
			],
		},
	},
	'5.vision/1.self-hosting.md': {
		en: {
			headings: '1232233322311332111111',
			fences: ['yaml', 'plain', 'yaml', 'plain', 'yaml', 'plain', 'bash', 'plain'],
			tables: ['13x3', '10x3', '6x3', '7x3', '6x3', '7x3'],
		},
		de: {
			headings: '1232233322311332111111',
			fences: ['yaml', 'plain', 'yaml', 'plain', 'yaml', 'plain', 'bash', 'plain'],
			tables: ['13x3', '10x3', '6x3', '7x3', '6x3', '6x3'],
		},
	},
};

const knownSymbolDrift = {
	'1.guide/23.feature-flags.md': { enOnly: ['COMPOSE_PROFILES'], deOnly: [] },
	'1.guide/34.code-tasks.md': {
		enOnly: ['CODE_WORKER_CONVEX_KEY', 'CODE_WORKER_PROXY_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY'],
		deOnly: [],
	},
	'3.developer/31.self-hosting-config.md': { enOnly: ['NUXT_PUBLIC_DEPLOYMENT_MODE'], deOnly: [] },
	'3.developer/38.dnsbl-delisting.md': { enOnly: [], deOnly: ['POST /ip-audit/run'] },
	'3.developer/8.environment-variables.md': {
		enOnly: [
			'CODE_WORKER_CONVEX_KEY',
			'CODE_WORKER_PROXY_TOKEN',
			'HTTPS_PROXY',
			'HTTP_PROXY',
			'NUXT_PUBLIC_DEPLOYMENT_MODE',
			'NUXT_PUBLIC_OWLAT_VERSION',
			'RATE_LIMIT_PROXY_SECRET',
			'RATE_LIMIT_TRUSTED_PROXIES',
			'REQUIRE_EMAIL_VERIFICATION',
		],
		deOnly: [],
	},
	'5.vision/1.self-hosting.md': { enOnly: ['CODE_WORKER_PROXY_TOKEN'], deOnly: [] },
};

describe('EN/DE body parity', () => {
	it('keeps heading levels, code fences, and table shapes aligned', () => {
		const drift = Object.fromEntries(
			pairs
				.map(
					({ path, english, german }) =>
						[path, { en: structure(english), de: structure(german) }] as const
				)
				.filter(([, value]) => JSON.stringify(value.en) !== JSON.stringify(value.de))
		);
		expect(drift).toEqual(knownStructureDrift);
	});

	it('keeps operator-facing environment variables and HTTP endpoints aligned', () => {
		const drift = Object.fromEntries(
			pairs
				.map(({ path, english, german }) => {
					const en = operatorSymbols(english);
					const de = operatorSymbols(german);
					return [path, { enOnly: difference(en, de), deOnly: difference(de, en) }] as const;
				})
				.filter(([, value]) => value.enOnly.length > 0 || value.deOnly.length > 0)
		);
		expect(drift).toEqual(knownSymbolDrift);
	});
});
