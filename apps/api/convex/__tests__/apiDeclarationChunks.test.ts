import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	chunkApiDeclaration,
	FULL_API_COMMENT,
	MAX_MODULES_PER_CHUNK,
} from '../../scripts/apiDeclarationChunks';
import type { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

const GENERATED = resolve(import.meta.dirname, '..', '_generated', 'api.d.ts');

function alias(path: string): string {
	return path.replace(/[/-]/g, '_');
}

function monolithic(paths: string[]): string {
	return [
		'/* header */',
		...paths.map((path) => `import type * as ${alias(path)} from "../${path}.js";`),
		'',
		"import type { ApiFromModules, FilterApi, FunctionReference } from 'convex/server';",
		'',
		'declare const fullApi: ApiFromModules<{',
		...paths.map((path) => `  "${path}": typeof ${alias(path)},`),
		'}>;',
		'export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;',
		'',
	].join('\n');
}

/** The entry paths of each chunk, in order. */
function chunksOf(declaration: string): string[][] {
	const lines = declaration.split('\n');
	const start = lines.indexOf('declare const fullApi: ApiFromModules<{');
	const chunks: string[][] = [[]];
	for (const line of lines.slice(start + 1)) {
		if (line === '}>;') break;
		if (line === '}> & ApiFromModules<{') chunks.push([]);
		else chunks.at(-1)?.push(/^['"]?([^'":]+)['"]?:/.exec(line.trim())?.[1] ?? line);
	}
	return chunks;
}

describe('chunkApiDeclaration', () => {
	it('splits the convex codegen map into one chunk per top-level directory', () => {
		const output = chunkApiDeclaration(
			monolithic([
				'crons',
				'mail/send',
				'delivery/queue',
				'mail/rules/apply',
				'http',
				'delivery/x-y',
			])
		);

		expect(chunksOf(output)).toEqual([
			['crons', 'http'],
			['delivery/queue', 'delivery/x-y'],
			['mail/send', 'mail/rules/apply'],
		]);
		expect(output).toContain('\t"delivery/x-y": typeof delivery_x_y;');
		expect(output).toContain(`${FULL_API_COMMENT.join('\n')}\ndeclare const fullApi`);
		// Imports, header and the api/internal declarations are left alone.
		expect(output.startsWith('/* header */\nimport type * as crons from "../crons.js";')).toBe(
			true
		);
		expect(output).toContain(
			'}>;\nexport declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;\n'
		);
	});

	it('is stable under a second run and keeps a hand-added entry in its directory chunk', () => {
		const once = chunkApiDeclaration(monolithic(['a/one', 'b/one', 'a/two']));
		expect(chunkApiDeclaration(once)).toBe(once);

		const handAdded = once.replace('}>;\nexport', "\t'a/three': typeof a_three;\n}>;\nexport");
		expect(chunksOf(chunkApiDeclaration(handAdded))).toEqual([
			['a/one', 'a/two', 'a/three'],
			['b/one'],
		]);
	});

	it('splits a directory over the chunk limit by subdirectory, then by size', () => {
		const direct = Array.from({ length: MAX_MODULES_PER_CHUNK + 1 }, (_, i) => `big/m${i}`);
		const nested = ['big/sub/a', 'big/sub/deep/b', 'big/other/c'];
		const chunks = chunksOf(chunkApiDeclaration(monolithic([...direct, ...nested, 'small/x'])));

		expect(chunks.map((chunk) => chunk.length)).toEqual([MAX_MODULES_PER_CHUNK, 1, 1, 2, 1]);
		expect(chunks.slice(2)).toEqual([
			['big/other/c'],
			['big/sub/a', 'big/sub/deep/b'],
			['small/x'],
		]);
		expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(
			MAX_MODULES_PER_CHUNK
		);
	});

	it('rejects a declaration it cannot read entry by entry', () => {
		expect(() => chunkApiDeclaration('export {};\n')).toThrow('no `declare const fullApi');
		expect(() =>
			chunkApiDeclaration(monolithic(['a/one']).replace('}>;', '\t// note\n}>;'))
		).toThrow('is not a fullApi module entry');
		expect(() =>
			chunkApiDeclaration(monolithic(['a/one']).replace('}>;', '\t"a/one": typeof a_one;\n}>;'))
		).toThrow("maps module 'a/one' twice");
	});

	it('leaves the committed declaration already chunked within the limit', () => {
		const committed = readFileSync(GENERATED, 'utf8');
		expect(chunkApiDeclaration(committed)).toBe(committed);
		const chunks = chunksOf(committed);
		expect(chunks.length).toBeGreaterThan(1);
		expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(
			MAX_MODULES_PER_CHUNK
		);
	});
});

// Compile-time checks, enforced by the apps/api typecheck: a declaration that
// TypeScript gives up on turns `api`/`internal` into `never` (or `any` when a
// module import cannot be resolved), and every call site then type-checks
// against nothing.
describe('generated api types', () => {
	it('keeps api and internal as typed function references', () => {
		expectTypeOf<typeof api>().not.toBeNever();
		expectTypeOf<typeof api>().not.toBeAny();
		expectTypeOf<typeof internal>().not.toBeNever();
		expectTypeOf<typeof internal>().not.toBeAny();

		type SetMuted = typeof api.mail.mute.setMutedForMessage;
		expectTypeOf<SetMuted>().toExtend<FunctionReference<'mutation', 'public'>>();
		expectTypeOf<FunctionArgs<SetMuted>>().toEqualTypeOf<{
			messageId: Id<'mailMessages'>;
			muted: boolean;
		}>();
		expectTypeOf<FunctionReturnType<SetMuted>>().toEqualTypeOf<{
			ok: true;
			threadId: Id<'mailThreads'>;
		}>();

		type Transition = typeof internal.inbox.processingLifecycle.transition;
		expectTypeOf<Transition>().toExtend<FunctionReference<'mutation', 'internal'>>();
		expectTypeOf<FunctionArgs<Transition>['inboundMessageId']>().toEqualTypeOf<
			Id<'inboundMessages'>
		>();
	});
});
