/**
 * The raw-palette gate's own gate, continued: the escape hatch.
 *
 * A hatch that covers more lines than it claims, or that a paragraph of prose
 * about `bg-white` can trip, is the failure mode with teeth — it turns the gate
 * off where nobody is looking. So each rule is proved by a pair: the marker
 * that must be honoured and the near-miss beside it that must not be.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupSandboxes, run } from './paletteClasses.testlib';

afterEach(cleanupSandboxes);

describe('the raw-palette gate, the escape hatch', () => {
	it('accepts a marker on its own line above the element', () => {
		const result = run({
			'apps/web/app/components/Paper.vue': [
				'<template>',
				'\t<!-- palette-ok: email paper ships its own light palette -->',
				'\t<div class="bg-white">Body</div>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('accepts a marker trailing the line it excuses', () => {
		const result = run({
			'apps/web/app/composables/usePaper.ts': [
				"export const paper = 'bg-white'; // palette-ok: email paper, not an app surface",
				'',
			].join('\n'),
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('reaches a class attribute several lines inside a multi-line start tag', () => {
		// HTML forbids a comment inside a start tag, so a marker that only covered
		// the NEXT line would be out of reach of exactly the elements that need it
		// most — every iframe would have to spend two lines on a region instead.
		const result = run({
			'apps/web/app/components/Preview.vue': [
				'<template>',
				'\t<!-- palette-ok: the rendered document paints its own light paper -->',
				'\t<iframe',
				'\t\t:srcdoc="html"',
				'\t\tsandbox=""',
				'\t\tclass="w-full bg-white"',
				'\t/>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('stops at the line that closes the start tag', () => {
		const result = run({
			'apps/web/app/components/Preview.vue': [
				'<template>',
				'\t<!-- palette-ok: the rendered document paints its own light paper -->',
				'\t<iframe',
				'\t\tclass="w-full bg-white"',
				'\t/>',
				'\t<p class="text-gray-500">Caption</p>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toContain('apps/web/app/components/Preview.vue:6');
		expect(result.output).not.toContain('Preview.vue:4');
		expect(result.status).toBe(1);
	});

	it('steps over blank lines and prose comments to reach the element', () => {
		// A marker often shares a comment block with the prose that explains the
		// element; the two must not have to be adjacent.
		const result = run({
			'apps/web/app/components/Preview.vue': [
				'<template>',
				'\t<!-- palette-ok: the rendered document paints its own light paper -->',
				'',
				'\t<!-- Sandboxed: no scripts, no app origin. -->',
				'\t<iframe class="bg-white" />',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('accepts a region around a whole surface', () => {
		// The wider case one element cannot state: every colour under the scrim is
		// literal for the same one reason.
		const result = run({
			'apps/web/app/components/Lightbox.vue': [
				'<template>',
				'\t<!-- palette-ok-start: chrome drawn on the fixed black scrim below -->',
				'\t<div class="fixed inset-0 bg-black/85">',
				'\t\t<p class="text-white/90">Name</p>',
				'\t\t<button class="hover:bg-white/10">Close</button>',
				'\t</div>',
				'\t<!-- palette-ok-end -->',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('does not let a marker excuse a line outside its scope', () => {
		const result = run({
			'apps/web/app/components/Paper.vue': [
				'<template>',
				'\t<!-- palette-ok: email paper ships its own light palette -->',
				'\t<div class="bg-white">Body</div>',
				'\t<div class="bg-white">Sidebar</div>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toContain('apps/web/app/components/Paper.vue:4');
		expect(result.output).not.toContain('Paper.vue:3');
		expect(result.status).toBe(1);
	});

	it.each([
		['a bare marker with no reason', '<!-- palette-ok -->', 'needs a reason'],
		['a marker whose colon has nothing after it', '<!-- palette-ok: -->', 'needs a reason'],
	])('rejects %s', (_label, marker, message) => {
		const result = run({
			'apps/web/app/components/Paper.vue': [
				'<template>',
				`\t${marker}`,
				'\t<div class="bg-white">Body</div>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toContain(message);
		expect(result.status).toBe(1);
	});

	it.each([
		[
			'a region that is never closed',
			['\t<!-- palette-ok-start: paper -->', '\t<div class="bg-white">Body</div>'],
			'never closed',
		],
		[
			'an end with no start',
			['\t<div class="bg-white">Body</div>', '\t<!-- palette-ok-end -->'],
			'without a palette-ok-start',
		],
	])('rejects %s', (_label, body, message) => {
		const result = run({
			'apps/web/app/components/Paper.vue': ['<template>', ...body, '</template>', ''].join('\n'),
		});

		expect(result.output).toContain(message);
		expect(result.status).toBe(1);
	});

	it.each([
		[
			'a single marker',
			['\t<!-- palette-ok: paper -->', '\t<div class="bg-bg-surface">Body</div>'],
		],
		[
			'a region',
			[
				'\t<!-- palette-ok-start: paper -->',
				'\t<div class="bg-bg-surface">Body</div>',
				'\t<!-- palette-ok-end -->',
			],
		],
	])('rejects %s that excuses nothing', (_label, body) => {
		// Strict in BOTH directions, like the member-jargon and provider-identity
		// baselines: an exemption whose element has since been re-tokenised excuses
		// nothing today and silently pre-approves the regression that puts the
		// palette class back tomorrow.
		const result = run({
			'apps/web/app/components/Paper.vue': ['<template>', ...body, '</template>', ''].join('\n'),
		});

		expect(result.output).toContain('Unused palette-ok exemption');
		expect(result.output).toContain('apps/web/app/components/Paper.vue:2');
		expect(result.status).toBe(1);
	});

	it('reports an unused exemption alongside a real violation, not instead of it', () => {
		// Both verdicts come out of the same completed scan and are independent
		// edits; hiding one behind the other turns a single fix into two round trips.
		const result = run({
			'apps/web/app/components/Paper.vue': [
				'<template>',
				'\t<!-- palette-ok: paper -->',
				'\t<div class="bg-bg-surface">Body</div>',
				'\t<div class="text-gray-500">Caption</div>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toContain('Raw palette classes in apps/web/app');
		expect(result.output).toContain('apps/web/app/components/Paper.vue:4');
		expect(result.output).toContain('Unused palette-ok exemption');
		expect(result.status).toBe(1);
	});
});
