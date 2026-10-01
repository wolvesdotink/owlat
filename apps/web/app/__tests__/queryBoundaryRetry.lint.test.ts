/**
 * TRY AGAIN RE-READS THE QUERY THAT FAILED, IT DOES NOT RELOAD THE APP (#1098).
 *
 * `UiQueryBoundary` renders Try again on its error state. With `@retry` wired,
 * the click refetches the failed read; without it, the boundary falls back to
 * `window.location.reload()`. That reload is a full boot (auth check, feature
 * flags, every warm subscription, the Postbox cache warm-up) and it throws away
 * open dialogs, scroll position and unsaved input elsewhere on screen.
 *
 * A SOURCE lint, so a new boundary cannot ship on the fallback by accident:
 * every `UiQueryBoundary` that binds `:error` must also wire `@retry`. A
 * surface with genuinely nothing to refetch says so with `reload-on-retry`,
 * and one that shows no retry control at all with `hide-retry`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const OPEN_TAG = /<(?:UiQueryBoundary|ui-query-boundary)(?=[\s/>])/g;
const BINDS_ERROR = /(?:^|\s)(?::|v-bind:)error\s*=/;
const WIRES_RETRY = /(?:^|\s)(?:@|v-on:)retry\s*=/;
const OPTS_OUT = /(?:^|\s):?(?:reload-on-retry|reloadOnRetry)(?=[\s=/]|$)/;
const HIDES_RETRY = /(?:^|\s):?(?:hide-retry|hideRetry)(?=[\s=/]|$)/;

interface Boundary {
	line: number;
	attrs: string;
}

/**
 * The `<template>` markup only: a `<script>` docblock may show a boundary as a
 * usage example, and a commented-out one renders nothing.
 */
function markupOf(source: string): string {
	const blank = (match: string) => match.replace(/[^\n]/g, ' ');
	return source.replace(/<script\b[\s\S]*?<\/script>/g, blank).replace(/<!--[\s\S]*?-->/g, blank);
}

/**
 * Each boundary's opening tag. Quote-aware, because a bound expression may
 * hold a `>` (`:empty="rows.length > 0"`, an arrow function).
 */
function boundariesIn(source: string): Boundary[] {
	const markup = markupOf(source);
	const found: Boundary[] = [];
	for (const match of markup.matchAll(OPEN_TAG)) {
		const start = match.index + match[0].length;
		let quote = '';
		let end = start;
		for (; end < markup.length; end += 1) {
			const char = markup[end]!;
			if (quote) {
				if (char === quote) quote = '';
			} else if (char === '"' || char === "'") {
				quote = char;
			} else if (char === '>') {
				break;
			}
		}
		found.push({
			line: markup.slice(0, match.index).split('\n').length,
			attrs: markup.slice(start, end).replace(/\/$/, ''),
		});
	}
	return found;
}

/** Why a boundary breaks the rule, or null when it keeps it. */
function retryProblem({ attrs }: Boundary): string | null {
	if (!BINDS_ERROR.test(attrs)) return null;
	const wired = WIRES_RETRY.test(attrs);
	const optedOut = OPTS_OUT.test(attrs);
	if (wired && optedOut) return '@retry and reload-on-retry together: the reload wins, drop one';
	if (wired || optedOut || HIDES_RETRY.test(attrs)) return null;
	return ':error without @retry: wire it to the failed read’s refetch';
}

function vueFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === '__tests__' || entry === 'node_modules') continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) vueFiles(path, out);
		else if (entry.endsWith('.vue')) out.push(path);
	}
	return out;
}

describe('the boundary check itself', () => {
	const problems = (template: string) =>
		boundariesIn(template).map((boundary) => retryProblem(boundary));

	it('flags a boundary with :error and no @retry', () => {
		expect(problems('<UiQueryBoundary :loading="isLoading" :error="error">')).toEqual([
			expect.stringContaining('without @retry'),
		]);
	});

	it('reads past a > inside a bound expression, across lines', () => {
		const template = `<UiQueryBoundary
			:empty="rows.length > 0"
			:error="error"
		>`;
		expect(problems(template)).toEqual([expect.stringContaining('without @retry')]);
		expect(problems(template.replace(':error', '@retry="refetch"\n:error'))).toEqual([null]);
	});

	it('accepts @retry, v-on:retry, reload-on-retry and hide-retry', () => {
		expect(
			problems(`
				<UiQueryBoundary :error="error" @retry="refetch" />
				<UiQueryBoundary :error="error" v-on:retry="retryAll" />
				<UiQueryBoundary :error="error" reload-on-retry />
				<UiQueryBoundary :error="error" hide-retry />
			`)
		).toEqual([null, null, null, null]);
	});

	it('flags @retry and reload-on-retry together', () => {
		expect(problems('<UiQueryBoundary :error="e" reload-on-retry @retry="refetch">')).toEqual([
			expect.stringContaining('together'),
		]);
	});

	it('ignores :error-title, boundaries without :error, and script docblocks', () => {
		expect(
			problems(`
				<script setup>
				/** <UiQueryBoundary :error="error"> */
				</script>
				<!-- <UiQueryBoundary :error="error"> -->
				<UiQueryBoundary :loading="isLoading" :error-title="title">
			`)
		).toEqual([null]);
	});
});

describe('every UiQueryBoundary with :error wires @retry (#1098)', () => {
	const boundaries = vueFiles(appRoot).flatMap((path) =>
		boundariesIn(readFileSync(path, 'utf8')).map((boundary) => ({
			where: `${relative(appRoot, path)}:${boundary.line}`,
			boundary,
		}))
	);

	it('finds the boundaries (a broken walk would pass silently)', () => {
		expect(boundaries.length).toBeGreaterThanOrEqual(80);
		expect(
			boundaries.filter(({ boundary }) => BINDS_ERROR.test(boundary.attrs)).length
		).toBeGreaterThanOrEqual(60);
	});

	it('leaves no boundary on the page-reload fallback', () => {
		const offenders = boundaries.flatMap(({ where, boundary }) => {
			const problem = retryProblem(boundary);
			return problem ? [`${where}: ${problem}`] : [];
		});
		expect(offenders).toEqual([]);
	});
});
