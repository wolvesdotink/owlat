import { describe, it, expect } from 'vitest';
import { ConvexError } from 'convex/values';
import type { CoeditOpArg } from '../../lib/validators/coediting';
import { applySessionOps, parseBlock, parseOps, type SessionState } from '../sessionOps';
import { TARGET_FIELDS, rootBlocksOf, type StoredRootBlock } from '../target';

const text = (id: string, html: string): StoredRootBlock => ({
	id,
	type: 'text',
	content: { html },
});

const state = (blocks: StoredRootBlock[], version = 1): SessionState => ({
	doc: { blocks, fields: { name: 'Name', subject: 'Subject', plainTextOverride: '' } },
	writes: [],
	version,
});

const update = (block: StoredRootBlock, baseVersion: number): CoeditOpArg => ({
	kind: 'update',
	block: JSON.stringify(block),
	afterId: null,
	baseVersion,
});

const run = (s: SessionState, ops: CoeditOpArg[], clientId: string) =>
	applySessionOps(s, parseOps(ops, TARGET_FIELDS.emailTemplate), clientId);

describe('applySessionOps', () => {
	it('merges edits to different blocks from two editors', () => {
		const base = state([text('a', 'A'), text('b', 'B')]);
		const first = run(base, [update(text('a', 'A mine'), 1)], 'tab-1');
		const second = run(first.state, [update(text('b', 'B theirs'), 1)], 'tab-2');

		expect(second.state.doc.blocks).toEqual([text('a', 'A mine'), text('b', 'B theirs')]);
		expect(second.state.version).toBe(3);
		expect(first.replaced).toEqual([]);
		expect(second.replaced).toEqual([]);
	});

	it('lets the later write win a block and reports the value it replaced', () => {
		const base = state([text('a', 'A')]);
		const first = run(base, [update(text('a', 'from tab 1'), 1)], 'tab-1');
		// Tab 2 edited the same block without having seen tab 1's write (v2).
		const second = run(first.state, [update(text('a', 'from tab 2'), 1)], 'tab-2');

		expect(second.state.doc.blocks).toEqual([text('a', 'from tab 2')]);
		expect(second.replaced).toEqual([
			{ key: 'block:a', clientId: 'tab-1', value: text('a', 'from tab 1') },
		]);
	});

	it('does not report a write the sender had already seen', () => {
		const first = run(state([text('a', 'A')]), [update(text('a', 'one'), 1)], 'tab-1');
		const second = run(first.state, [update(text('a', 'two'), 2)], 'tab-2');
		expect(second.replaced).toEqual([]);
	});

	it('never reports an editor replacing its own write', () => {
		const first = run(state([text('a', 'A')]), [update(text('a', 'one'), 1)], 'tab-1');
		const second = run(first.state, [update(text('a', 'two'), 1)], 'tab-1');
		expect(second.replaced).toEqual([]);
	});

	it('reports a delete that removes a change the deleter had not seen', () => {
		const first = run(state([text('a', 'A')]), [update(text('a', 'edited'), 1)], 'tab-1');
		const second = run(first.state, [{ kind: 'delete', blockId: 'a', baseVersion: 1 }], 'tab-2');
		expect(second.state.doc.blocks).toEqual([]);
		expect(second.replaced.map((r) => r.key)).toEqual(['block:a']);
	});

	it('reports field conflicts like block conflicts', () => {
		const field = (value: string, baseVersion: number): CoeditOpArg => ({
			kind: 'field',
			field: 'subject',
			value: JSON.stringify(value),
			baseVersion,
		});
		const first = run(state([]), [field('Mine', 1)], 'tab-1');
		const second = run(first.state, [field('Theirs', 1)], 'tab-2');
		expect(second.state.doc.fields['subject']).toBe('Theirs');
		expect(second.replaced).toEqual([{ key: 'field:subject', clientId: 'tab-1', value: 'Mine' }]);
	});

	it('does not count a move as a write', () => {
		const first = run(
			state([text('a', 'A'), text('b', 'B')]),
			[update(text('a', 'x'), 1)],
			'tab-1'
		);
		const moved = run(first.state, [{ kind: 'move', blockId: 'a', afterId: 'b' }], 'tab-2');
		expect(moved.replaced).toEqual([]);
		expect(moved.state.doc.blocks.map((b) => b.id)).toEqual(['b', 'a']);
		expect(moved.state.writes.find((w) => w.key === 'block:a')?.clientId).toBe('tab-1');
	});

	it('forgets the writers of deleted blocks', () => {
		const first = run(state([text('a', 'A')]), [update(text('a', 'x'), 1)], 'tab-1');
		const second = run(first.state, [{ kind: 'delete', blockId: 'a', baseVersion: 2 }], 'tab-1');
		expect(second.state.writes).toEqual([]);
	});
});

describe('parseOps', () => {
	const invalid = (fn: () => unknown) => {
		expect(fn).toThrow(ConvexError);
	};

	it('sanitizes block HTML', () => {
		const block = parseBlock(
			JSON.stringify(text('a', '<p>Hi</p><img src=x onerror="alert(1)"><script>x()</script>'))
		);
		const html = (block['content'] as { html: string }).html;
		expect(html).not.toContain('onerror');
		expect(html).not.toContain('<script');
	});

	it('refuses a block without an id or a type', () => {
		invalid(() => parseBlock(JSON.stringify({ type: 'text' })));
		invalid(() => parseBlock(JSON.stringify({ id: 'a' })));
		invalid(() => parseBlock('not json'));
	});

	it('refuses a field the target does not share, or a value of the wrong type', () => {
		const field = (name: 'attachments' | 'subject', value: unknown): CoeditOpArg => ({
			kind: 'field',
			field: name,
			value: JSON.stringify(value),
			baseVersion: 1,
		});
		invalid(() => parseOps([field('attachments', [])], TARGET_FIELDS.emailTemplate));
		invalid(() => parseOps([field('subject', 42)], TARGET_FIELDS.emailTemplate));
		expect(parseOps([field('attachments', [])], TARGET_FIELDS.transactionalEmail)).toHaveLength(1);
	});

	it('refuses an oversized batch', () => {
		const ops = Array.from({ length: 201 }, () => ({
			kind: 'delete' as const,
			blockId: 'a',
			baseVersion: 1,
		}));
		invalid(() => parseOps(ops, TARGET_FIELDS.emailTemplate));
	});
});

describe('rootBlocksOf', () => {
	it('unwraps the envelope, drops non-blocks and gives every root a unique id', () => {
		const roots = rootBlocksOf(
			JSON.stringify({
				blocks: [
					{ id: 'a', type: 'text' },
					{ id: 'a', type: 'text' },
					{ type: 'divider' },
					'junk',
					{ id: 'x' },
				],
			})
		);
		expect(roots).toHaveLength(3);
		expect(roots[0]!.id).toBe('a');
		expect(new Set(roots.map((r) => r.id)).size).toBe(3);
	});

	it('reads invalid JSON as an empty email', () => {
		expect(rootBlocksOf('{')).toEqual([]);
	});
});
