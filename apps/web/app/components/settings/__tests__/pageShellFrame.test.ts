/**
 * Settings pages render inside SettingsPageShell, which is their one frame
 * (padding, reading width, left alignment). A page root that brings its own
 * `p-*`, `max-w-*` or `mx-auto` would bring back the sideways jump between
 * neighbouring pages the shell exists to remove, so none may.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pagesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../pages');
const FRAME =
	/^(?:(?:sm|md|lg|xl|2xl):)?(?:(?:p|px|py|pt|pb|pl|pr)-\S+|max-w-\S+|mx-auto)$/;

function vueFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (name === '__tests__') return [];
		if (statSync(path).isDirectory()) return vueFiles(path);
		return name.endsWith('.vue') ? [path] : [];
	});
}

/** The class list of each top-level element of the page template. */
function rootClasses(source: string): string[][] {
	const start = source.indexOf('\n<template>');
	const end = source.lastIndexOf('</template>');
	if (start < 0 || end < 0) return [];
	const template = source.slice(start + '\n<template>'.length, end);
	const tag = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
	const roots: string[][] = [];
	let depth = 0;
	for (const match of template.matchAll(tag)) {
		const [whole, closing, name, attrs, selfClosing] = match;
		if (whole.startsWith('<!--') || (name === 'template' && depth === 0)) continue;
		if (closing) {
			depth -= 1;
			continue;
		}
		if (depth === 0) {
			const cls = /(?<![:\w])class="([^"]*)"/.exec(attrs ?? '');
			roots.push(cls ? cls[1]!.split(/\s+/).filter(Boolean) : []);
		}
		if (!selfClosing) depth += 1;
	}
	return roots;
}

describe('settings pages leave the frame to SettingsPageShell', () => {
	const settingsPages = vueFiles(join(pagesRoot, 'dashboard')).filter((file) =>
		/layout: '(admin|preferences)'/.test(readFileSync(file, 'utf8'))
	);

	it('finds the settings pages', () => {
		expect(settingsPages.length).toBeGreaterThan(40);
	});

	it('gives no page root its own padding, width or centring', () => {
		const offenders = settingsPages.flatMap((file) =>
			rootClasses(readFileSync(file, 'utf8'))
				.flat()
				.filter((cls) => FRAME.test(cls))
				.map((cls) => `${relative(pagesRoot, file)}: ${cls}`)
		);
		expect(offenders).toEqual([]);
	});
});
