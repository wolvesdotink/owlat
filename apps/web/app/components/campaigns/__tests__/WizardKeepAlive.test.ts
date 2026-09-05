// @vitest-environment happy-dom
/**
 * The campaign wizard wraps its steps in <KeepAlive> so a step's component
 * instance survives navigation to a sibling step and back. KeepAlive only
 * keeps a single child alive, so a comment placed directly inside the slot
 * silently breaks the persistence; the template AST is checked for that.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@vue/compiler-sfc';

describe('campaign wizard KeepAlive persistence', () => {
	it('keeps the campaign creation KeepAlive slot free of direct comments', () => {
		const pagePath = resolve(__dirname, '../../../pages/dashboard/campaigns/new.vue');
		const source = readFileSync(pagePath, 'utf8');
		const ast = parse(source, { filename: pagePath }).descriptor.template?.ast;

		function findKeepAlive(node: { type: number; tag?: string; children?: unknown[] }): {
			children?: { type: number }[];
		} | null {
			if (node.type === 1 && node.tag === 'KeepAlive') {
				return node as { children?: { type: number }[] };
			}

			for (const child of node.children ?? []) {
				const found = findKeepAlive(child as { type: number; tag?: string; children?: unknown[] });
				if (found) return found;
			}

			return null;
		}

		const keepAlive = ast ? findKeepAlive(ast) : null;
		expect(keepAlive).not.toBeNull();

		const directComments = keepAlive?.children?.filter((child) => child.type === 3) ?? [];

		expect(directComments).toEqual([]);
	});
});
