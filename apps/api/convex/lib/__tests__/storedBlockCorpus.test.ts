/**
 * The stored EditorBlock corpus (packages/email-renderer/src/__tests__/
 * storedBlocks, rules in its corpus.ts) seen from the server:
 *
 * - every `contentBlockVersion` from 1 to CURRENT_CONTENT_BLOCK_VERSION has
 *   fixtures, or is retired with the migration that rewrote its rows
 *   (CONVENTIONS.md, "Versioning rules");
 * - the server render of each stored template and transactional email
 *   (`renderPublishableEmail`, the path of every save, publish and saved-block
 *   rerender) is the HTML the renderer's corpus test snapshotted for
 *   CURRENT_RENDERER_VERSION.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CURRENT_CONTENT_BLOCK_VERSION, CURRENT_RENDERER_VERSION } from '../constants';
import {
	renderPublishableEmail,
	type PublishableEmailVariableType,
} from '../publishableEmailRender';

const CONVEX_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = resolve(
	CONVEX_ROOT,
	'../../../packages/email-renderer/src/__tests__/storedBlocks'
);
const SNAPSHOT_DIR = join(CORPUS_DIR, 'snapshots', `renderer-v${CURRENT_RENDERER_VERSION}`);

/** The stored columns the server renders, with their variable syntax. */
const SERVER_RENDERED: Record<string, PublishableEmailVariableType> = {
	'emailTemplates.content': 'personalization',
	'transactionalEmails.content': 'data',
};

interface Fixture {
	name: string;
	field: string;
	stored: string;
}

function corpusVersions(): number[] {
	return readdirSync(CORPUS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
		.map((entry) => Number(entry.name.slice(1)));
}

function fixturesOf(version: number): Fixture[] {
	const dir = join(CORPUS_DIR, `v${version}`);
	return readdirSync(dir)
		.filter((file) => file.endsWith('.json'))
		.map((file) => {
			const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
				field: string;
				stored: unknown;
			};
			return {
				name: file.slice(0, -'.json'.length),
				field: raw.field,
				stored: JSON.stringify(raw.stored),
			};
		});
}

/** Same normalization as the renderer's corpus: carousels draw a random class prefix. */
const stableHtml = (html: string): string =>
	html.replace(/owlat-car-[a-z0-9]+/g, 'owlat-car-RANDOM');

describe('stored EditorBlock corpus', () => {
	const retired = JSON.parse(readFileSync(join(CORPUS_DIR, 'retired.json'), 'utf8')) as Record<
		string,
		string
	>;
	const versions = corpusVersions();

	it('covers every contentBlockVersion up to the current one', () => {
		expect(Math.max(...versions)).toBeLessThanOrEqual(CURRENT_CONTENT_BLOCK_VERSION);
		for (let version = 1; version <= CURRENT_CONTENT_BLOCK_VERSION; version++) {
			const migration = retired[String(version)];
			if (migration === undefined) {
				expect(versions, `contentBlockVersion ${version} has no fixtures`).toContain(version);
				expect(fixturesOf(version).length).toBeGreaterThan(0);
			} else {
				expect(versions, `retired contentBlockVersion ${version} kept its fixtures`).not.toContain(
					version
				);
				expect(existsSync(join(CONVEX_ROOT, migration)), migration).toBe(true);
			}
		}
	});

	const serverRendered = versions
		.flatMap(fixturesOf)
		.filter((fixture) => fixture.field in SERVER_RENDERED);

	it('has template and transactional fixtures', () => {
		expect(serverRendered.map((fixture) => fixture.field)).toEqual(
			expect.arrayContaining(Object.keys(SERVER_RENDERED))
		);
	});

	it.each(serverRendered)('$name renders on the server as snapshotted', (fixture) => {
		const rendered = renderPublishableEmail(
			{ content: fixture.stored, subject: 'Corpus' },
			SERVER_RENDERED[fixture.field]!,
			undefined
		);
		expect(rendered.plainTextContent).toBeTypeOf('string');
		const snapshot = join(SNAPSHOT_DIR, `${fixture.name}.html`);
		expect(existsSync(snapshot), `${snapshot}: run the email-renderer tests first`).toBe(true);
		expect(stableHtml(rendered.html)).toBe(readFileSync(snapshot, 'utf8'));
	});
});
