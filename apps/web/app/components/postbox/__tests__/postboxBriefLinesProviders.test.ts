/**
 * The viewer's "Show the brief above conversations" reaches every message row
 * (usePostboxBriefLines): a row injects it, so every list that renders rows
 * has to provide it, or its rows would keep the AI's brief and gist lines with
 * the brief turned off. This pins that: each component that renders
 * PostboxThreadRow or PostboxThreadRowBody calls provideBriefLines, and the
 * composable reads a missing provider as on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import {
	POSTBOX_BRIEF_LINES,
	provideBriefLines,
	useBriefLinesShown,
} from '~/composables/postbox/usePostboxBriefLines';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the brief preference reaches every row', () => {
	it('is provided by every list that renders message rows', () => {
		const renderers = readdirSync(dir)
			.filter((name) => name.endsWith('.vue'))
			.filter((name) => name !== 'PostboxThreadRow.vue')
			.filter((name) =>
				/<PostboxThreadRow(Body)?[\s/>]/.test(readFileSync(join(dir, name), 'utf8'))
			);
		expect(renderers.sort()).toEqual([
			'PostboxThreadBundleList.vue',
			'PostboxThreadList.vue',
			'PostboxThreadSectionList.vue',
		]);
		for (const name of renderers) {
			expect(readFileSync(join(dir, name), 'utf8'), name).toMatch(/provideBriefLines\(/);
		}
	});

	it('reads as on without a provider, and follows the provided preference', async () => {
		const seen: boolean[] = [];
		const row = defineComponent({
			setup() {
				const shown = useBriefLinesShown();
				return () => {
					seen.push(shown.value);
					return h('span');
				};
			},
		});
		mount(row);
		expect(seen.at(-1)).toBe(true);

		const preference = ref(false);
		const list = defineComponent({
			setup() {
				provideBriefLines(preference);
				return () => h(row);
			},
		});
		const w = mount(list);
		expect(seen.at(-1)).toBe(false);
		preference.value = true;
		await w.vm.$nextTick();
		expect(seen.at(-1)).toBe(true);

		// A list whose settings stub has no preference leaves the default.
		const bare = defineComponent({
			setup() {
				provideBriefLines(undefined);
				return () => h(row);
			},
		});
		mount(bare);
		expect(seen.at(-1)).toBe(true);
		expect(typeof POSTBOX_BRIEF_LINES).toBe('symbol');
	});
});
