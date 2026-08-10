import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Template guards for two role-gating regressions on the dashboard surfaces.
 * Both pages are Convex-query driven and awkward to mount in happy-dom, so — as
 * with the other page guards in this directory — we assert the load-bearing
 * template facts instead.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

describe('dashboard home: Customize', () => {
	const source = read('../index.vue');

	it('the Customize trigger and the editor it opens share one visibility', () => {
		const trigger = source.match(/<UiButton\b[^>]*@click="openEditor"[^>]*>/)?.[0];
		const editor = source.match(/<DashboardEditor\b[\s\S]*?>/)?.[0];

		expect(trigger).toBeDefined();
		expect(editor).toBeDefined();
		// A role gate on only one of the two leaves the other role with a button
		// that silently does nothing. `saveLayout` is an authed (not admin)
		// mutation and `getAvailableCards` is role-filtered server-side, so both
		// stay ungated.
		expect(trigger).not.toMatch(/\bv-(if|show)\b/);
		expect(editor).not.toMatch(/\bv-(if|show)\b/);
	});
});

describe('contact detail: activity timeline subscription', () => {
	const source = read('../audience/contacts/[id].vue');

	it('gates the activity subscription on the admin-only tab being open', () => {
		// The Activity tab is admin-only and 'profile' is the default tab, so an
		// ungated useActivityTimeline() subscribes on every contact page for a
		// surface members can never open.
		const call = source.match(/useActivityTimeline\([\s\S]*?\);/)?.[0];
		expect(call).toBeDefined();
		expect(call).toMatch(/isActivityTabActive/);

		const gate = source.match(/const isActivityTabActive = computed\([^;]*\);/)?.[0];
		expect(gate).toBeDefined();
		expect(gate).toMatch(/isAdmin\.value/);
		expect(gate).toMatch(/activeTab\.value === 'activity'/);
	});
});
