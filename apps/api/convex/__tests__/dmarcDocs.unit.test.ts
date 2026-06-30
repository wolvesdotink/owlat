/**
 * Docs-lint for the DMARC record documented in the developer email-system guide.
 *
 * Regression for PR-67: the "DNS Records Generated" table documented
 * `v=DMARC1; p=none; rua=mailto:dmarc@{domain}`, a value the code never emits —
 * `buildDmarcRecordValue` omits `rua=` unless the operator sets `MTA_DMARC_RUA`
 * and never synthesises a `dmarc@<customer-domain>` mailbox. This asserts the
 * doc row tracks the code's actual omit-by-default output so the two can't drift.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDmarcRecordValue } from '../domains/dmarc';

const DOCS_FILE = join(
	import.meta.dirname,
	'..',
	'..',
	'..',
	'docs',
	'content',
	'3.developer',
	'6.email-system.md',
);

/** The DMARC row of the "DNS Records Generated" table. */
function dmarcDocRow(): string {
	const content = readFileSync(DOCS_FILE, 'utf8');
	const row = content
		.split('\n')
		.find((line) => /^\|\s*DMARC\s*\|/.test(line));
	if (!row) throw new Error('DMARC row not found in email-system.md DNS records table');
	return row;
}

describe('email-system.md DMARC record row', () => {
	it('does not document a synthesised dmarc@{domain} reporting mailbox', () => {
		expect(dmarcDocRow()).not.toContain('rua=mailto:dmarc@');
	});

	it('documents the omit-by-default value that buildDmarcRecordValue actually emits', () => {
		const actual = buildDmarcRecordValue('example.com', { policy: 'none' });
		expect(actual).toBe('v=DMARC1; p=none');
		// The doc row must contain the value the code emits by default.
		expect(dmarcDocRow()).toContain(actual);
	});
});
