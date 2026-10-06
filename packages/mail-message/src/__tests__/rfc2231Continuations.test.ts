/**
 * RFC 2231 parameter continuations (`name*0`, `name*1*`, ...). The index is
 * attacker-chosen: `getRawParam` used to place each segment into an array at
 * that index and join it, so `filename*4294967294` made the join walk four
 * billion slots. Segments are now kept by index and joined in index order,
 * and an index past `MAX_CONTINUATION_INDEX` is ignored (as one past the
 * largest array index always was). Everything else assembles as before: gaps
 * close up, segments sort by index, a later duplicate wins, and `*N*`
 * extended segments percent-decode with plain ones.
 */
import { describe, expect, it } from 'vitest';
import {
	MAX_CONTINUATION_INDEX,
	getRawParam,
	parseStructuredHeader,
	decodeRfc2231,
} from '../parse/headers';
import { parseMimeTreeWithBounds, walkLeaves, partFilename } from '../parse/body';
import { locateMimeTree } from '../parse/locate';

/** `getRawParam` as it was, for the inputs it handled in reasonable time. */
function previousGetRawParam(headerValue: string, name: string): string | undefined {
	const continued: string[] = [];
	const contRe = new RegExp(
		`(?:^|[;\\s])${name}\\*(\\d+)\\*?\\s*=\\s*("([^"]*)"|([^;\\r\\n]+))`,
		'gi'
	);
	let cm: RegExpExecArray | null;
	while ((cm = contRe.exec(headerValue))) {
		continued[Number.parseInt(cm[1]!, 10)] = (cm[3] ?? cm[4] ?? '').trim();
	}
	if (continued.length > 0) return decodeRfc2231(continued.join(''));
	const re = new RegExp(`(?:^|[;\\s])${name}\\*?\\s*=\\s*("([^"]*)"|([^;\\r\\n]+))`, 'i');
	const m = headerValue.match(re);
	const value = m ? (m[2] ?? m[3] ?? '') : undefined;
	return value ? decodeRfc2231(value.trim()) : undefined;
}

const CASES: Record<string, [string, string | undefined]> = {
	plain: ['attachment; filename="report.pdf"', 'report.pdf'],
	'in order': ['attachment; filename*0="re"; filename*1="port.pdf"', 'report.pdf'],
	'out of order': ['attachment; filename*1="port.pdf"; filename*0="re"', 'report.pdf'],
	'with a gap': ['attachment; filename*0="a"; filename*2="c"', 'ac'],
	'a later duplicate wins': ['attachment; filename*0="a"; filename*0="z"', 'z'],
	'extended mixed with plain': [
		'attachment; filename*0*=utf-8\'\'%E2%82%AC; filename*1=".pdf"',
		'€.pdf',
	],
	'unquoted segments': ['attachment; filename*0=re; filename*1=port.pdf', 'report.pdf'],
	'no semicolon before the param': ['attachment filename*0="x.txt"', 'x.txt'],
	'only an index past the cap': [
		`attachment; filename*${MAX_CONTINUATION_INDEX + 1}="b"`,
		undefined,
	],
	'an index past the cap beside real ones': [
		'attachment; filename*0="a"; filename*4294967294="b"; filename*1="c"',
		'ac',
	],
};

describe('getRawParam continuations', () => {
	it.each(Object.entries(CASES))('%s', (_name, [header, expected]) => {
		expect(getRawParam(header, 'filename')).toBe(expected);
	});

	it('assembles exactly as before for every index the cap keeps', () => {
		const random = (() => {
			let seed = 7;
			return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		})();
		for (let run = 0; run < 2000; run++) {
			const count = 1 + Math.floor(random() * 6);
			const params = Array.from({ length: count }, () => {
				const index = Math.floor(random() * 25);
				const star = random() < 0.3 ? '*' : '';
				const value = random() < 0.5 ? `"v${Math.floor(random() * 99)}"` : `p${run}`;
				return `filename*${index}${star}=${value}`;
			});
			const header = `attachment; ${params.join('; ')}`;
			expect(getRawParam(header, 'filename'), header).toBe(previousGetRawParam(header, 'filename'));
		}
	});
});

describe('parseStructuredHeader continuations', () => {
	it('ignores an index past the cap and keeps the rest', () => {
		const { params } = parseStructuredHeader(
			'multipart/mixed; boundary*0="ab"; boundary*99999999="zz"; boundary*1="cd"'
		);
		expect(params['boundary']).toBe('abcd');
	});
});

describe('huge continuation indexes stay cheap', () => {
	const huge = ['100000000', '4294967294', '4294967295', '9'.repeat(400)];
	const message = (index: string) =>
		[
			`Content-Type: multipart/mixed; boundary="b"; boundary*${index}="x"`,
			'',
			...Array.from({ length: 3 }, () => [
				'--b',
				`Content-Type: application/pdf; name*${index}="n.pdf"`,
				`Content-Disposition: attachment; filename*${index}="a.txt"`,
				'',
				'x',
			]).flat(),
			'--b--',
			'',
		].join('\r\n');

	it.each(huge)('index %s: parsed in well under 50 ms, and ignored', (index) => {
		const text = message(index);
		const raw = Uint8Array.from(text, (c) => c.charCodeAt(0));
		const started = performance.now();
		for (const name of ['filename', 'name', 'boundary']) {
			expect(getRawParam(`x; ${name}*${index}="v"`, name)).toBeUndefined();
		}
		const walked = parseMimeTreeWithBounds(text);
		const located = locateMimeTree(raw);
		const filenames: string[] = [];
		walkLeaves(walked.root, (leaf) => filenames.push(partFilename(leaf)));
		expect(performance.now() - started).toBeLessThan(50);
		expect(walked.root.children).toHaveLength(3);
		expect(located.root.children).toHaveLength(3);
		expect(filenames).toEqual(['', '', '']);
	});
});
