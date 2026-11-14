/**
 * The shipped compose files give the MTA a fixed `environment:` map and no
 * `env_file`, so a variable the map leaves out never reaches the container. An
 * operator sets it in `.env`, the backend and the transport editor report it,
 * and the MTA quietly runs on its built-in default instead.
 *
 * The read set is taken from the MTA source: every key passed to `process.env`,
 * to an `env` map, to the config loader's `optionalEnv` / `requiredEnv` /
 * `intEnv` helpers or a helper handed `optionalEnv`, and the variable names
 * given to the shared TLS loader. Each compose file must forward all of them,
 * with the MTA's own default where the source states a literal one, so that
 * an unset variable behaves the same with or without compose in between.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MTA_SOURCE = join(REPOSITORY_ROOT, 'apps/mta/src');
const COMPOSE_FILES = ['docker-compose.yml', 'infra/templates/docker-compose.vps.yml'] as const;

/** Read by the MTA but deliberately left out of the compose files. */
const NOT_FORWARDED: Record<string, string> = {
	MTA_SERVER_ID:
		'defaults to the container hostname; compose cannot leave a key unset, and an empty value would replace that default',
	MTA_ALLOW_PRIVATE_MX:
		'turns off the screening of loopback and private MX targets for a lab stack; a production install must not be able to switch it on from .env, so an operator adds it to the service by hand',
};

const NAME = String.raw`'([A-Z][A-Z0-9_]*)'`;
const READ_SHAPES = [
	new RegExp(String.raw`process\.env\[\s*${NAME}\s*\]`, 'g'),
	/process\.env\.([A-Z][A-Z0-9_]*)/g,
	new RegExp(String.raw`\benv\[\s*${NAME}\s*\]`, 'g'),
	new RegExp(String.raw`\b(?:optionalEnv|requiredEnv|intEnv)\(\s*${NAME}`, 'g'),
	new RegExp(String.raw`\(\s*optionalEnv\s*,\s*${NAME}`, 'g'),
	new RegExp(String.raw`\b(?:inlineCert|inlineKey|certFile|keyFile):\s*${NAME}`, 'g'),
];
const STRING_DEFAULT = new RegExp(String.raw`\boptionalEnv\(\s*${NAME},\s*'([^']*)'\s*\)`, 'g');
const INT_DEFAULT = new RegExp(String.raw`\bintEnv\(\s*${NAME},\s*([0-9][0-9_]*)\b`, 'g');
const FALLBACK_DEFAULT = new RegExp(
	String.raw`process\.env\[\s*${NAME}\s*\]\s*\?\?\s*'([^']*)'`,
	'g'
);
const UPPER_LITERAL = /'([A-Z][A-Z0-9_]{2,})'/g;
/** `${NAME}`, `${NAME-default}` or `${NAME:-default}`; `${NAME:?}` is required, so has none. */
const DEFAULTED = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-(.*))?\}$/s;

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
		return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
	});
}

const SOURCES = sourceFiles(MTA_SOURCE).map((path) => ({
	path: relative(REPOSITORY_ROOT, path),
	text: readFileSync(path, 'utf8'),
}));

/** Variable name → the source files that read it. */
function mtaReads(): Map<string, string[]> {
	const reads = new Map<string, string[]>();
	for (const { path, text } of SOURCES) {
		for (const shape of READ_SHAPES) {
			for (const match of text.matchAll(shape)) {
				const files = reads.get(match[1]!) ?? [];
				if (!files.includes(path)) files.push(path);
				reads.set(match[1]!, files);
			}
		}
	}
	return reads;
}

/** Literal defaults the config loader states, normalised to compose's spelling. */
function codeDefaults(): Map<string, string> {
	const defaults = new Map<string, string>();
	for (const { text } of SOURCES) {
		for (const shape of [STRING_DEFAULT, FALLBACK_DEFAULT]) {
			for (const match of text.matchAll(shape)) defaults.set(match[1]!, match[2]!);
		}
		for (const match of text.matchAll(INT_DEFAULT)) {
			defaults.set(match[1]!, match[2]!.replaceAll('_', ''));
		}
	}
	return defaults;
}

function mtaEnvironment(file: string): Record<string, unknown> {
	const compose = parse(readFileSync(join(REPOSITORY_ROOT, file), 'utf8')) as {
		services: { mta: { environment: Record<string, unknown> } };
	};
	return compose.services.mta.environment;
}

const READS = mtaReads();

describe('MTA environment reads', () => {
	it('finds a read of every shape the MTA uses', () => {
		for (const name of [
			'EHLO_HOSTNAME',
			'OUTBOUND_TLS_MODE',
			'SMTP_POOL_MAX_PER_HOST',
			'DANE_MODE',
			'WEBHOOK_DLQ_MAX_SIZE',
			'BOUNCE_TLS_CERT_FILE',
			'TLS_CERT_DIR',
			'MTA_IPV6_ENABLED',
			'LOG_LEVEL',
		]) {
			expect(READS.has(name), name).toBe(true);
		}
	});

	it('leaves no variable name in an env-reading module unrecognised', () => {
		const unrecognised: string[] = [];
		for (const { path, text } of SOURCES) {
			if (![...READS.values()].some((files) => files.includes(path))) continue;
			for (const match of text.matchAll(UPPER_LITERAL)) {
				if (!READS.has(match[1]!)) unrecognised.push(`${path}: ${match[1]}`);
			}
		}
		expect(
			unrecognised,
			'a new read shape: teach READ_SHAPES in this file to recognise it'
		).toEqual([]);
	});

	it('lists only variables the MTA still reads as deliberately not forwarded', () => {
		expect(Object.keys(NOT_FORWARDED).filter((name) => !READS.has(name))).toEqual([]);
	});
});

describe.each(COMPOSE_FILES)('%s mta service', (file) => {
	const environment = mtaEnvironment(file);

	it('forwards every variable the MTA reads', () => {
		const missing = [...READS.keys()]
			.filter((name) => !(name in environment) && !(name in NOT_FORWARDED))
			.sort();
		expect(missing, `add these to the mta environment in ${file}`).toEqual([]);
	});

	it('leaves out the variables that must stay unset', () => {
		expect(Object.keys(NOT_FORWARDED).filter((name) => name in environment)).toEqual([]);
	});

	it("defaults each forwarded setting to the MTA's own default", () => {
		const defaults = codeDefaults();
		const drifted: string[] = [];
		for (const [name, value] of Object.entries(environment)) {
			const expected = defaults.get(name);
			const interpolation = typeof value === 'string' ? DEFAULTED.exec(value) : null;
			if (expected === undefined || !interpolation) continue;
			if ((interpolation[1] ?? '') !== expected) {
				drifted.push(`${name}: compose ${JSON.stringify(value)}, MTA default ${expected}`);
			}
		}
		expect(drifted).toEqual([]);
	});
});

describe('.env.selfhost.example', () => {
	it('documents every MTA setting the root compose file takes from .env', () => {
		const documented = readFileSync(join(REPOSITORY_ROOT, '.env.selfhost.example'), 'utf8');
		const undocumented = Object.entries(mtaEnvironment('docker-compose.yml'))
			.filter(([name, value]) => READS.has(name) && String(value).startsWith(`\${${name}`))
			.map(([name]) => name)
			.filter((name) => !new RegExp(`^(?:# ?)?${name}=`, 'm').test(documented));
		expect(undocumented).toEqual([]);
	});
});
