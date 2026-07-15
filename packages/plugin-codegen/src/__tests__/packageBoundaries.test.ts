import { describe, expect, it } from 'vitest';
import { findDirectPluginImports } from '../packageBoundaries';

const configuredPackages = ['@acme/mail-plugin'];

describe('plugin package boundary lint', () => {
	it.each([
		[`import plugin from '@acme/mail-plugin';`, '@acme/mail-plugin'],
		[`export { plugin } from '@acme/mail-plugin/runtime';`, '@acme/mail-plugin/runtime'],
		[`const plugin = await import('@acme/mail-plugin');`, '@acme/mail-plugin'],
		[`const plugin = require('@acme/mail-plugin/server');`, '@acme/mail-plugin/server'],
		[`type Plugin = import('@acme/mail-plugin').Plugin;`, '@acme/mail-plugin'],
	] as const)('finds a configured package import in core source', (source, packageSpecifier) => {
		expect(findDirectPluginImports(source, 'apps/api/core.ts', configuredPackages)).toEqual([
			{ file: 'apps/api/core.ts', packageSpecifier },
		]);
	});

	it('finds imports inside Vue script blocks', () => {
		const source = `<template><div /></template><script setup lang="ts">import plugin from '@acme/mail-plugin';</script>`;
		expect(findDirectPluginImports(source, 'apps/web/app.vue', configuredPackages)).toHaveLength(1);
	});

	it('ignores comments, ordinary strings, and similarly named packages', () => {
		const source = `
      // import '@acme/mail-plugin';
      const example = "import '@acme/mail-plugin'";
      import sibling from '@acme/mail-plugin-extra';
      void example;
      void sibling;
    `;
		expect(findDirectPluginImports(source, 'apps/api/core.ts', configuredPackages)).toEqual([]);
	});
});
