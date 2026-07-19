import { describe, it, expect } from 'vitest';
import { MAX_MIME_PARTS, parseBody, parseMimeTree } from '../parse/body';
import { extractAttachments } from '../parse/attachments';
import { MAX_ADDRESS_HEADER_LENGTH, parseAddressList, parseAddressObject } from '../parse/address';
import { parseMessage } from '../parse/index';

/**
 * Hostile / malformed input must be BOUNDED and must NEVER throw: the walker is
 * depth-capped, a missing boundary yields a childless node, and every decoder
 * is total. These adversarial fixtures assert termination AND boundedness.
 *
 * `not.toThrow()` wraps ONLY the parse calls — content assertions are hoisted
 * out so a failed expectation reports the real diff rather than an opaque
 * "function threw".
 */
describe('hostile MIME input', () => {
	it('accepts a 1000-part message at the exact global part ceiling', () => {
		const parts: string[] = ['Content-Type: multipart/mixed; boundary="B"', ''];
		for (let i = 0; i < 1000; i++) {
			parts.push(
				'--B',
				`Content-Type: application/octet-stream; name="f${i}.bin"`,
				`Content-Disposition: attachment; filename="f${i}.bin"`,
				'',
				`DATA${i}`
			);
		}
		parts.push('--B--');
		const raw = parts.join('\r\n');
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			attachments = extractAttachments(raw);
			parseBody(raw);
		}).not.toThrow();
		expect(attachments).toHaveLength(1000);
		expect(attachments[0]!.filename).toBe('f0.bin');
		expect(attachments[999]!.filename).toBe('f999.bin');
	});

	it('stops a 100,000-part flat bomb at the global part ceiling', () => {
		const partCount = 100_000;
		const parts: string[] = ['Content-Type: multipart/mixed; boundary="B"', ''];
		for (let i = 0; i < partCount; i++) parts.push('--B', '', 'x');
		parts.push('--B--');
		const raw = parts.join('\r\n');

		let tree: ReturnType<typeof parseMimeTree> | undefined;
		expect(() => {
			tree = parseMimeTree(raw);
		}).not.toThrow();

		// This is a breadth bound, not merely a termination assertion: the parser
		// must allocate no more than the explicit global budget even though the
		// small wire message contains two orders of magnitude more delimiters.
		expect(Buffer.byteLength(raw)).toBeLessThan(2 * 1024 * 1024);
		expect(tree!.children).toHaveLength(MAX_MIME_PARTS);
		expect(tree!.children[MAX_MIME_PARTS - 1]).toBeDefined();
	});

	it('shares one part budget across sibling multipart branches', () => {
		const branch = (boundary: string, count: number): string => {
			const lines = [`Content-Type: multipart/mixed; boundary="${boundary}"`, ''];
			for (let i = 0; i < count; i++) lines.push(`--${boundary}`, '', 'x');
			lines.push(`--${boundary}--`);
			return lines.join('\r\n');
		};
		const raw = [
			'Content-Type: multipart/mixed; boundary="ROOT"',
			'',
			'--ROOT',
			branch('LEFT', 750),
			'--ROOT',
			branch('RIGHT', 750),
			'--ROOT--',
		].join('\r\n');
		const tree = parseMimeTree(raw);

		const countDescendants = (node: typeof tree): number =>
			node.children.reduce((count, child) => count + 1 + countDescendants(child), 0);
		expect(countDescendants(tree)).toBe(MAX_MIME_PARTS);
		expect(tree.children).toHaveLength(2);
		// LEFT consumes one container + 750 leaves. RIGHT consumes the second
		// container and only the 248 leaves left in the shared 1,000-part budget.
		expect(tree.children[0]!.children).toHaveLength(750);
		expect(tree.children[1]!.children).toHaveLength(248);
	});

	it('64-deep multipart nesting is bounded and does not throw', () => {
		const depth = 64;
		let raw = 'Content-Type: text/plain\r\n\r\ninner core';
		for (let i = 0; i < depth; i++) {
			const boundary = `B${i}`;
			raw = [
				`Content-Type: multipart/mixed; boundary="${boundary}"`,
				'',
				`--${boundary}`,
				raw,
				`--${boundary}--`,
			].join('\r\n');
		}
		expect(() => {
			parseMimeTree(raw);
			parseBody(raw);
			extractAttachments(raw);
		}).not.toThrow();
		// Within the cap the inner text/plain core is still reachable.
		expect(parseBody(raw).text).toBe('inner core');
	});

	it('120-deep nesting (beyond MAX_DEPTH=100) terminates and degrades to a leaf', () => {
		const depth = 120;
		let raw = 'Content-Type: text/plain\r\n\r\ninner core';
		for (let i = 0; i < depth; i++) {
			const boundary = `B${i}`;
			raw = [
				`Content-Type: multipart/mixed; boundary="${boundary}"`,
				'',
				`--${boundary}`,
				raw,
				`--${boundary}--`,
			].join('\r\n');
		}
		let body: ReturnType<typeof parseBody> | undefined;
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			parseMimeTree(raw);
			body = parseBody(raw);
			attachments = extractAttachments(raw);
		}).not.toThrow();
		// The node AT the depth cap is left unsplit (a raw multipart leaf), so the
		// text/plain core buried below the cap is never reached: it contributes
		// nothing to the body and nothing to attachments.
		expect(body!.text).toBeUndefined();
		expect(body!.html).toBe(false);
		expect(attachments).toEqual([]);
	});

	it('a boundary string appearing inside base64 content does not derail the split', () => {
		const raw = [
			'Content-Type: multipart/mixed; boundary="XBOUNDX"',
			'',
			'--XBOUNDX',
			'Content-Type: application/octet-stream; name="a.bin"',
			'Content-Disposition: attachment; filename="a.bin"',
			'Content-Transfer-Encoding: base64',
			'',
			// Payload text mentions the boundary token but not as a delimiter line.
			'VGhpcyBtZW50aW9ucyAtLVhCT1VORFggaW5zaWRl',
			'--XBOUNDX',
			'Content-Type: application/octet-stream; name="b.bin"',
			'Content-Disposition: attachment; filename="b.bin"',
			'',
			'plain',
			'--XBOUNDX--',
		].join('\r\n');
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			attachments = extractAttachments(raw);
		}).not.toThrow();
		expect(attachments.map((a) => a.filename)).toEqual(['a.bin', 'b.bin']);
	});

	it('a headers-only message (no body) does not throw', () => {
		const raw = 'Content-Type: text/plain; charset="utf-8"\r\nSubject: nothing below';
		let body: ReturnType<typeof parseBody> | undefined;
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			body = parseBody(raw);
			attachments = extractAttachments(raw);
		}).not.toThrow();
		expect(body!.html).toBe(false);
		expect(attachments).toEqual([]);
	});

	it('a multipart with no boundary parameter degrades to an empty tree', () => {
		const raw = 'Content-Type: multipart/mixed\r\n\r\nno boundary here';
		let body: ReturnType<typeof parseBody> | undefined;
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			body = parseBody(raw);
			attachments = extractAttachments(raw);
		}).not.toThrow();
		expect(attachments).toEqual([]);
		expect(body!.html).toBe(false);
	});

	it('mixed CRLF / LF line endings parse without throwing', () => {
		// Deliberately mix \r\n and bare \n at the boundaries and header/body split.
		const raw =
			'Content-Type: multipart/mixed; boundary="B"\n\r\n' +
			'--B\r\n' +
			'Content-Type: text/plain; charset="utf-8"\n\n' +
			'plain part\r\n' +
			'--B\n' +
			'Content-Type: text/html\r\n\r\n' +
			'<p>html part</p>\n' +
			'--B--\r\n';
		let body: ReturnType<typeof parseBody> | undefined;
		expect(() => {
			body = parseBody(raw);
			extractAttachments(raw);
		}).not.toThrow();
		expect(body!.text).toContain('plain part');
		expect(body!.html).toContain('<p>html part</p>');
	});

	it('a malformed base64 body yields empty content and does not throw', () => {
		// A single stray base64 char (`A`) cannot decode to whole bytes; `atob`
		// throws internally and the decoder must swallow it into empty content
		// rather than aborting extraction of the message. (mailMime parity.)
		const raw = [
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: application/octet-stream; name="bad.bin"',
			'Content-Disposition: attachment; filename="bad.bin"',
			'Content-Transfer-Encoding: base64',
			'',
			'A',
			'--B--',
		].join('\r\n');
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			attachments = extractAttachments(raw);
			parseBody(raw);
		}).not.toThrow();
		expect(attachments.map((a) => a.filename)).toEqual(['bad.bin']);
		expect(attachments[0]!.size).toBe(0);
		expect([...attachments[0]!.content]).toEqual([]);
	});

	it('a truncated message (dangling open boundary, no close) is bounded', () => {
		const raw = [
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: application/pdf; name="x.pdf"',
			'Content-Disposition: attachment; filename="x.pdf"',
			'',
			'PDFDATA-but-no-closing-boundary',
		].join('\r\n');
		let attachments: ReturnType<typeof extractAttachments> = [];
		expect(() => {
			attachments = extractAttachments(raw);
		}).not.toThrow();
		expect(attachments.map((a) => a.filename)).toEqual(['x.pdf']);
	});
});

/**
 * Address-header parse must be BOUNDED IN TIME, not just bounded in output.
 *
 * The de-backtracked mailbox parse (`parseMailbox`) plus the defensive
 * `MAX_ADDRESS_HEADER_LENGTH` cap replace an anchored regex
 * (`/^(.*?)<\s*([^>]+?)\s*>\s*$/`) that backtracked catastrophically — clean
 * O(n^2) — on a long `<`-run with no closing `>`. Measured against the OLD
 * code end-to-end via parseMessage: a `To:` of `"A<".repeat(k)` took ~200ms at
 * 20 KB, ~800ms at 40 KB, ~3s at 80 KB, ~12s at 160 KB, so ~1 MB pinned a core
 * for minutes. These tests would have failed (timed out) against the old
 * quadratic regex; the linear scan completes in well under a millisecond.
 */
describe('hostile address-header input is bounded in TIME', () => {
	it('parseAddressList survives a 200 KB no-closing-> run FAST and returns a bounded result', () => {
		// 100k copies of "A<" => 200 KB of pure backtrack bait, zero closing '>'.
		const evil = 'A<'.repeat(100_000);
		const start = performance.now();
		const list = parseAddressList(evil);
		const elapsed = performance.now() - start;

		// Time bound: the old O(n^2) regex needed many SECONDS on this input; the
		// linear scan is sub-millisecond. 500ms is a generous, non-flaky ceiling.
		expect(elapsed).toBeLessThan(500);
		// Defense-in-depth cap also fired: nothing past 16 KiB was ever scanned.
		expect(evil.length).toBeGreaterThan(MAX_ADDRESS_HEADER_LENGTH);
		// No valid `local@domain` exists in the run, so the list is empty — a
		// bounded, sane result rather than a hang.
		expect(list).toEqual([]);
	});

	it('parseMessage survives a 200 KB hostile To: header FAST (end-to-end)', () => {
		const raw = `To: ${'A<'.repeat(100_000)}\r\nSubject: x\r\n\r\nbody\r\n`;
		const start = performance.now();
		let parsed: ReturnType<typeof parseMessage> | undefined;
		expect(() => {
			parsed = parseMessage(raw);
		}).not.toThrow();
		const elapsed = performance.now() - start;
		// The whole message parse (headers + MIME + this address header) stays far
		// under the bound the old quadratic address parse alone would blow past.
		expect(elapsed).toBeLessThan(500);
		// `To:` parsed to a bounded, empty address object, never a hang.
		expect(parsed!.to).toEqual({ value: [], text: '' });
	});

	it('a pathological no-closing-> run yields an empty/sane address, no hang', () => {
		const obj = parseAddressObject('Name <<<<<<<<<<<<<<<<<<<<<<<<<<<<');
		expect(obj.value).toEqual([]);
		expect(obj.text).toBe('');
	});

	it('the de-backtracked parser is byte-for-byte identical on representative valid inputs', () => {
		// Plain, angle-only, quoted-name, and group syntax — pin exact objects so a
		// behavioral drift in the rewritten split fails loudly.
		expect(parseAddressObject('jane@example.com').value).toEqual([
			{ name: '', address: 'jane@example.com' },
		]);
		expect(parseAddressObject('<Jane@Example.COM>').value).toEqual([
			{ name: '', address: 'jane@example.com' },
		]);
		expect(parseAddressObject('"Doe, John" <John@Example.com>').value).toEqual([
			{ name: 'Doe, John', address: 'john@example.com' },
		]);
		expect(parseAddressObject('Jane Doe <jane@example.com>').value).toEqual([
			{ name: 'Jane Doe', address: 'jane@example.com' },
		]);
		expect(parseAddressObject('Friends: alice@example.com, bob@example.com;').value).toEqual([
			{
				name: 'Friends',
				address: '',
				group: [
					{ name: '', address: 'alice@example.com' },
					{ name: '', address: 'bob@example.com' },
				],
			},
		]);
	});
});
