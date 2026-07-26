import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sidebarConfig } from '../app/utils/sidebarConfig';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const doc = readFileSync(resolve(repoRoot, 'apps/docs/content/1.guide/52.secure-email.md'), 'utf8');

describe('secure email guide', () => {
	it('is linked from the guide sidebar', () => {
		const links = sidebarConfig.flatMap((group) => group.items.map((item) => item.to));
		expect(links).toContain('/guide/secure-email');
	});

	it('keeps transport encryption distinct from end-to-end encryption', () => {
		expect(doc).toMatch(/Transport encryption protects the \*\*pipe\*\*/);
		expect(doc).toMatch(/ordinary TLS is \*\*hop-by-hop\*\*/);
		expect(doc).toMatch(/end-to-end \*\*between the sending and receiving Owlat workspaces\*\*/);
	});

	it('states Sealed Mail scope and fallback behavior honestly', () => {
		expect(doc).toMatch(/personal mail in Postbox/);
		expect(doc).toMatch(/Campaign and transactional email remain unsealed/);
		expect(doc).toMatch(/distinct \*\*Send unsealed\*\* action/);
	});

	it('embeds both purpose-built illustrations', () => {
		expect(doc).toContain('::secure-email-journey');
		expect(doc).toContain('::owlat-security-layers');
	});
});
