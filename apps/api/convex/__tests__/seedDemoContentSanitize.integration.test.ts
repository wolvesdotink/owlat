/**
 * The demo / sample-data loaders write template, transactional email and
 * saved block content through the same write-time sanitizer as the public
 * mutations, and store HTML rendered on the server from that content.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { emailTemplatesLoader } from '../seedDemo/loaders/emailTemplates';
import { transactionalEmailsLoader } from '../seedDemo/loaders/transactionalEmails';
import { savedBlocksLoader } from '../seedDemo/loaders/savedBlocks';

const modules = import.meta.glob('../**/*.*s');

const UNSAFE = '<p>Hello</p><img src="x" onerror="window.__x=1"><a href="javascript:void 0">x</a>';
const content = JSON.stringify([{ id: 'b1', type: 'text', content: { html: UNSAFE } }]);
const fixtureHtml =
	'<html><body><p>fixture copy</p><img src="x" onerror="window.__x=1"></body></html>';

function expectClean(stored: string | undefined) {
	expect(stored).toBeDefined();
	expect(stored).toContain('Hello');
	expect(stored).not.toContain('onerror');
	expect(stored).not.toContain('javascript:');
}

const options = { inert: true };

describe('seed demo content loaders', () => {
	it('sanitizes template blocks and renders their HTML', async () => {
		const t = convexTest(schema, modules);
		const result = await t.run((ctx) =>
			emailTemplatesLoader.load(
				ctx,
				[
					{
						slug: 'welcome',
						name: 'Welcome',
						type: 'marketing',
						subject: 'Hi',
						status: 'published',
						content,
						htmlContent: fixtureHtml,
					},
				],
				{},
				options
			)
		);
		const row = await t.run((ctx) => ctx.db.get(result.ids['welcome'] as never));
		const template = row as { content: string; htmlContent?: string };
		expectClean(template.content);
		expectClean(template.htmlContent);
		expect(template.htmlContent).not.toContain('fixture copy');
	});

	it('sanitizes transactional email blocks and renders their HTML', async () => {
		const t = convexTest(schema, modules);
		const result = await t.run((ctx) =>
			transactionalEmailsLoader.load(
				ctx,
				[
					{
						slug: 'receipt',
						name: 'Receipt',
						subject: 'Your receipt',
						status: 'published',
						content,
						htmlContent: fixtureHtml,
					},
				],
				{},
				options
			)
		);
		const row = await t.run((ctx) => ctx.db.get(result.ids['receipt'] as never));
		const email = row as { content: string; htmlContent?: string };
		expectClean(email.content);
		expectClean(email.htmlContent);
		expect(email.htmlContent).not.toContain('fixture copy');
	});

	it('sanitizes saved block content', async () => {
		const t = convexTest(schema, modules);
		const result = await t.run((ctx) =>
			savedBlocksLoader.load(
				ctx,
				[
					{
						slug: 'footer',
						name: 'Footer',
						content: JSON.stringify({ blocks: JSON.parse(content) }),
					},
				],
				{},
				options
			)
		);
		const row = await t.run((ctx) => ctx.db.get(result.ids['footer'] as never));
		expectClean((row as { content: string }).content);
	});
});
