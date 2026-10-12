/**
 * Every action that can reach a model anchors its model budget at handler
 * entry (ADR-0073, `lib/llm/actionDeadline.ts`). Anchoring later (at the first
 * model call) would let a slow setup push the deadline past the action's own
 * 600-second limit. "Can reach a model" is the runtime-import closure of the
 * dispatch modules; an action in that closure anchors first thing, or its
 * handler delegates straight to a function that does.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const convexRoot = join(import.meta.dirname, '..', '..', '..');

function sources(dir: string, out: Map<string, string> = new Map()): Map<string, string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (!['_generated', '__tests__', '__eval__', 'node_modules'].includes(name))
				sources(path, out);
		} else if (
			name.endsWith('.ts') &&
			!name.endsWith('.test.ts') &&
			!name.endsWith('.testlib.ts')
		) {
			out.set(normalize(relative(convexRoot, path)), readFileSync(path, 'utf8'));
		}
	}
	return out;
}

const SEEDS = [
	'lib/llm/dispatch.ts',
	'lib/llm/dispatchStream.ts',
	'lib/llm/embed.ts',
	'analytics/meteredSpend.ts',
	'lib/decision/dispatch.ts',
];
const RUNTIME_IMPORT = /^import (?!type )[^;]*?from '(\.[^']+)';/gms;
const ACTION = /=\s*(?:internalAction|action|authedAction|adminAction)\(/g;

function modelReachingModules(files: Map<string, string>): Set<string> {
	const deps = new Map<string, string[]>();
	for (const [path, text] of files) {
		const found: string[] = [];
		for (const match of text.matchAll(RUNTIME_IMPORT)) {
			const target = normalize(join(dirname(path), match[1]!));
			for (const candidate of [`${target}.ts`, join(target, 'index.ts')]) {
				if (files.has(candidate)) {
					found.push(candidate);
					break;
				}
			}
		}
		deps.set(path, found);
	}
	const reach = new Set(SEEDS);
	for (let grew = true; grew;) {
		grew = false;
		for (const [path, found] of deps) {
			if (!reach.has(path) && found.some((dep) => reach.has(dep))) {
				reach.add(path);
				grew = true;
			}
		}
	}
	return reach;
}

/** Handlers in `text` that neither anchor first nor delegate to an anchoring function. */
function unanchoredHandlers(text: string): string[] {
	const misses: string[] = [];
	for (const match of text.matchAll(ACTION)) {
		const handlerAt = text.indexOf('handler:', match.index);
		const arrowAt = text.indexOf('=>', handlerAt);
		const params = text.slice(handlerAt, arrowAt);
		if (params.includes('(_ctx')) continue; // never touches a model
		const body = text.slice(arrowAt, arrowAt + 260);
		if (/^=>\s*\{\s*(?:\/\/[^\n]*\n\s*)*anchorActionDeadline\(ctx\)/.test(body)) continue;
		const delegate = /^=>\s*(?:\{\s*return\s+)?(\w+)\(ctx\b/.exec(body)?.[1];
		if (delegate) {
			const fn = new RegExp(`function ${delegate}\\b[^{]*\\{\\s*anchorActionDeadline\\(ctx\\)`);
			const viaBlock = new RegExp(
				`=>\\s*\\{\\s*anchorActionDeadline\\(ctx\\);\\s*return ${delegate}\\(`
			);
			if (fn.test(text) || viaBlock.test(body)) continue;
		}
		misses.push(
			text
				.slice(match.index - 60, match.index)
				.split('\n')
				.pop() ?? ''
		);
	}
	return misses;
}

describe('model budget anchoring', () => {
	it('anchors every model-reaching action at handler entry', () => {
		const files = sources(convexRoot);
		const reach = modelReachingModules(files);
		const missing: string[] = [];
		for (const path of reach) {
			for (const miss of unanchoredHandlers(files.get(path)!)) missing.push(`${path}: ${miss}`);
		}
		expect(missing).toEqual([]);
		// The closure is not trivially empty.
		const withActions = [...reach].filter((path) =>
			new RegExp(ACTION.source).test(files.get(path)!)
		);
		expect(withActions.length).toBeGreaterThan(20);
	});
});
