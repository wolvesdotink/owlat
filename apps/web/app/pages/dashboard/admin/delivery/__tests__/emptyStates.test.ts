import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Delivery-group empty-state guards (UX plan T12b).
 *
 * Five near-identical blocks were copied across these three pages — a `card`
 * box, a 56px filled `UiIconBox` disc, a bolded `<p>` standing in for a
 * heading, a tertiary `<p>`, and sometimes a button. They now all route
 * through the shared `UiEmptyState` ladder, whose rendered structure is covered
 * by real mounts in `packages/ui/__tests__/EmptyState.test.ts`.
 *
 * Two of the five are NOT empty lists at all: "no team selected" / "no
 * workspace selected" are preconditions, so they carry the surface's own name
 * as the eyebrow rather than the default "Nothing here yet", which would claim
 * something untrue about data the page has not even asked for yet.
 *
 * These pages are Convex-query driven and awkward to mount in happy-dom, so —
 * as the sibling `domainsPageCopy.test.ts` and the dashboard-wide
 * `emptyStates.test.ts` do — the load-bearing template facts are asserted
 * against the source.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

const pages = {
	domains: read('../domains.vue'),
	webhooks: read('../webhooks.vue'),
	providerRouting: read('../provider-routing.vue'),
	deliverability: read('../deliverability.vue'),
};

describe.each(Object.entries(pages))('%s — no forked empty markup left', (_name, source) => {
	it('drops the copied card box and its 56px icon disc', () => {
		expect(source).not.toContain('card flex flex-col items-center justify-center py-16');
		expect(source).not.toContain('rounded="full" class="mb-4"');
	});

	it('drops the bolded paragraph that stood in for a heading', () => {
		expect(source).not.toContain('text-text-secondary font-medium">');
	});
});

describe('sending domains', () => {
	const source = pages.domains;

	it('routes the no-domains state through the shared component, keeping its one action', () => {
		expect(source).toMatch(
			/<UiEmptyState[\s\S]*?:title="t\('dashboard\.admin\.delivery\.domains\.empty\.title'\)"[\s\S]*?<template #action>[\s\S]*?addModal\.open\(\)/
		);
	});

	it('names the surface in the eyebrow for the no-team precondition', () => {
		expect(source).toMatch(
			/<UiEmptyState\s+v-else-if="!hasActiveOrganization"[\s\S]*?:eyebrow="t\('dashboard\.admin\.delivery\.domains\.title'\)"/
		);
	});

	it('still renders the domain list when there ARE domains', () => {
		expect(source).toContain('v-for="domain in domainsData"');
	});
});

describe('webhooks', () => {
	const source = pages.webhooks;

	it('routes the no-webhooks state through the shared component, keeping its one action', () => {
		expect(source).toMatch(
			/<UiEmptyState[\s\S]*?:title="t\('dashboard\.admin\.delivery\.webhooks\.empty\.title'\)"[\s\S]*?<template #action>[\s\S]*?openCreateModal/
		);
	});

	it('names the surface in the eyebrow for the no-workspace precondition', () => {
		expect(source).toMatch(
			/<UiEmptyState\s+v-else-if="!hasActiveOrganization"[\s\S]*?:eyebrow="t\('dashboard\.admin\.delivery\.webhooks\.title'\)"/
		);
	});

	it('still renders the webhook list when there ARE webhooks', () => {
		expect(source).toContain('v-for="webhook in webhooks"');
	});
});

describe('provider routing', () => {
	const source = pages.providerRouting;

	it('names the surface in the eyebrow for the no-workspace precondition', () => {
		expect(source).toMatch(
			/<UiEmptyState\s+v-else-if="!hasActiveOrganization"[\s\S]*?:eyebrow="t\('dashboard\.admin\.delivery\.providerRouting\.title'\)"/
		);
	});
});

describe('deliverability', () => {
	const source = pages.deliverability;

	it('anchors its CTA to the #action slot rather than the default children', () => {
		// The default slot rendered nothing at all in the previous component, so
		// this empty state shipped with no way out of it.
		expect(source).toMatch(
			/<UiEmptyState[\s\S]*?<template #action>[\s\S]*?dashboard\.admin\.delivery\.deliverability\.empty\.action/
		);
	});
});
