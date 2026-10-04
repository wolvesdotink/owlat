/**
 * Leaked tool-call markup in draft text (lib/llm/toolMarkup.ts, #1254): the
 * final-text check every draft surface runs and the streaming view Answer mode
 * shows while the model writes.
 */

import { describe, it, expect } from 'vitest';
import { stripLeakedToolMarkup, visibleDraftStreamText } from '../toolMarkup';

const REPLY =
	'Hi John,\n\nThanks for getting in touch. We have rooms on those dates.\n\nBest,\nAda';

/** The issue's example, names neutralised. */
const ISSUE_PREFIX =
	'<invoke name="recallKnowledge">\n' +
	'<parameter name="query">availability 14-16 December 2026 for 2 guests</parameter>\n' +
	'</invoke>\n\n' +
	'<function_results>\n{"results":[]}\n</function_results>';

/** The namespace one model family prints (spelled in two parts on purpose). */
const VENDOR_NS = ['ant', 'ml'].join('');

/** The inline block the second review found: a complete call between two sentences. */
const INLINE_BLOCK =
	'Let me check. <tool_call>{"name":"recallKnowledge","arguments":{"query":"availability"}}</tool_call>';

/** The third review's block: a stray prose backtick pairs with one inside the call's JSON. */
const STRAY_TICK_BLOCK =
	'Let me check `availability. <tool_call>{"name":"recallKnowledge","arguments":{"query":"`December dates"}}</tool_call>';

/** The fourth review's blocks: a stray backtick pairs into the payload, closer or none. */
const PAYLOAD_TICK_UNCLOSED =
	'Let me check `availability. <tool_call>{"name":"recallKnowledge","arguments":{"query":"`December dates"}}';
const PAYLOAD_TICK_SPAN =
	'Let me check `availability. <tool_call>{"name":"recallKnowledge","arguments":{"query":"`December` dates"}}</tool_call>Hi John`';

/** Leading prefixes the stripper must cut, and the stream must never show. */
const PREFIXES: Array<[string, string]> = [
	['the issue example', ISSUE_PREFIX],
	['space inside a container tag', '<function_calls >{}</function_calls >\n'],
	['a newline inside the name attribute', '<invoke name=\n"recallKnowledge">\n</invoke>\n'],
	['single quotes', "<invoke name='recallKnowledge'><parameter name='q'>x</parameter></invoke>"],
	[
		'several blocks',
		'\n  <function_calls>\n<invoke name="recallKnowledge">\n<parameter name="query">a</parameter>\n</invoke>\n</function_calls>\n' +
			'<function_results>\n<result>\n<name>recallKnowledge</name>\n<output>{}</output>\n</result>\n</function_results>\n\n',
	],
	[
		'tool_call',
		'<tool_call>\n{"name": "recallKnowledge", "arguments": {"query": "x"}}\n</tool_call>\n',
	],
	['tool_use', '<tool_use>{"name":"recallKnowledge"}</tool_use>'],
	['tool_calls', '<tool_calls>[{"name":"recallKnowledge"}]</tool_calls>\n'],
	['tool_result', '<tool_result>{"facts":[]}</tool_result>\n'],
	['a short namespace', '<ns:invoke name="recallKnowledge"></ns:invoke>\n'],
	[
		'the vendor namespace',
		`<${VENDOR_NS}:function_calls><${VENDOR_NS}:invoke name="recallKnowledge"></${VENDOR_NS}:invoke></${VENDOR_NS}:function_calls>\n`,
	],
	['a namespace with _ . and -', '<my_ns.v-2:invoke name="recallKnowledge"></my_ns.v-2:invoke>'],
	[
		'upper case',
		'<INVOKE NAME="recallKnowledge"></INVOKE>\n<Function_Results>{}</FUNCTION_RESULTS>',
	],
	['a bare result block', '<result>{"facts":[]}</result>\n'],
	['a stray closing tag', '</function_results>'],
	['a stray closing result tag', '</result>\n'],
	['a byte-order mark', '﻿<tool_call>{}</tool_call>'],
];

describe('stripLeakedToolMarkup — leading prefix', () => {
	it.each(PREFIXES)('strips %s and keeps the reply', (_label, prefix) => {
		expect(stripLeakedToolMarkup(prefix + REPLY)).toEqual({ kind: 'stripped', text: REPLY });
	});

	it('leaves a reply without markup untouched, byte for byte', () => {
		const text = '  Hi John,\n\nsee you then &amp; bye.  ';
		expect(stripLeakedToolMarkup(text)).toEqual({ kind: 'clean', text });
	});
});

describe('stripLeakedToolMarkup — unusable', () => {
	it.each([
		[
			'markup after the reply started',
			`Let me check availability.\n\n${ISSUE_PREFIX}${REPLY}`,
			'embedded',
		],
		[
			'markup left after a stripped prefix',
			`${ISSUE_PREFIX}Hi John,\n<invoke name="recallKnowledge"></invoke>\nBest`,
			'embedded',
		],
		['an inline container block', `${INLINE_BLOCK}${REPLY}`, 'embedded'],
		['a block a stray backtick pairs into', `${STRAY_TICK_BLOCK}Hi John`, 'embedded'],
		[
			'a block whose closer sits outside the opener span',
			'Hi, `<tool_call>{}` </tool_call> Best',
			'embedded',
		],
		[
			'a block on its own line',
			'Hi John,\n\n  <tool_call>\n{"name":"x"}\n</tool_call>\nBest',
			'embedded',
		],
		[
			'an upper-case namespaced block',
			'Hi John, <NS:FUNCTION_CALLS></ns:function_calls> Best',
			'embedded',
		],
		['a named invoke inline', `Hi John, <invoke name="recallKnowledge"> and more`, 'embedded'],
		[
			'a named invoke in a code span',
			'Hi John, `<invoke name="recallKnowledge">` and more',
			'embedded',
		],
		[
			'a broken invoke once its name started',
			'Hi,\n<invoke name="recallKnowledge" id="1">\nBest',
			'embedded',
		],
		['a stray backtick and an unclosed block', PAYLOAD_TICK_UNCLOSED, 'embedded'],
		['a stray backtick and a backtick-wrapped closer', PAYLOAD_TICK_SPAN, 'embedded'],
		[
			'a container opener that never closes',
			'Hi John,\n<tool_call>{"name":"recallKnowledge"',
			'embedded',
		],
		[
			'a container opener mentioned in prose',
			'Hi,\n\nwrap each call in <tool_call> tags.',
			'embedded',
		],
		// Quotes in code count too (the trade-off in the module comment).
		[
			'a container mentioned in a code span',
			'Hi,\n\nwrap it in `<tool_call>`, then send it.',
			'embedded',
		],
		[
			'an opener and closer in code spans',
			'Hi,\n\nwrap each call in `<tool_call>` and `</tool_call>` tags.',
			'embedded',
		],
		[
			'a whole block in a code span',
			'Hi,\n\nit looks like `<tool_call>{}</tool_call>` there.',
			'embedded',
		],
		[
			'a fenced sample that encloses a whole block',
			'Hi,\n\n```\n<function_calls>\n<invoke>x</invoke>\n</function_calls>\n```\nBest',
			'embedded',
		],
		[
			'a fenced block sample',
			'Hi,\n\nfor example:\n```xml\n<tool_call>{"name":"x"}</tool_call>\n```\nBest',
			'embedded',
		],
		[
			'a block that never closes',
			'<invoke name="recallKnowledge">\n<parameter name="q">x',
			'unclosed',
		],
		['an unclosed function_calls opener', '<function_calls>\n<invoke name="x">', 'unclosed'],
		['a prefix with no reply after it', `${ISSUE_PREFIX}\n \n`, 'empty'],
		['a generation cut inside a leading tag', '<invoke name="recallKnowledge"', 'unfinished'],
		['a generation cut inside an attribute', '<invoke name=\n', 'unfinished'],
		['a generation cut inside a leading result tag', '<result', 'unfinished'],
		['a generation cut inside a leading closer', '</resu', 'unfinished'],
		['a generation cut after a prefix', `${ISSUE_PREFIX}<func`, 'unfinished'],
		['a reply cut inside an invoke', 'Hi John,\n\n<invoke name="recall', 'unfinished'],
		['a reply cut inside a container name', 'Hi John,\n<function_ca', 'unfinished'],
		['a reply cut inside an inline container name', 'Hi John, <tool_ca', 'unfinished'],
	])('reports %s', (_label, text, reason) => {
		expect(stripLeakedToolMarkup(text)).toEqual({ kind: 'unusable', reason });
	});
});

describe('stripLeakedToolMarkup — prose is not markup', () => {
	it.each([
		['a closing tag on its own', `${REPLY}\n</function_calls>`],
		['a lone closing tool_call tag', 'Hi,\n\nthat ends with </tool_call> as usual.'],
		['a broken container opener', 'Hi,\n<tool_call id="1">{}</tool_call>\nBest'],
		[
			'a bare <parameter> in a code sample',
			'Hi,\n\nadd `<parameter>` to the config:\n<parameter>30</parameter>\n\nBest',
		],
		[
			'a named <parameter> inside the reply',
			'Hi,\n\nset it like this:\n<parameter name="timeout">30</parameter>\n\nBest',
		],
		['a <result> element inside the reply', 'Hi,\n\nthe API answers with <result>ok</result>.'],
		[
			'an <invoke> without a name, closer included',
			'Hi,\n\nwrite <invoke>foo</invoke> like this:\n<invoke>foo</invoke>',
		],
		['an invoke mentioned without its name', 'Hi,\n\nthe <invoke element is deprecated.'],
		['comparison signs, arrows and hearts', 'Hi,\n\nif a < b and c > d -> ok <3'],
		['an HTML-looking reply', '<p>Hi John,</p>\n<p>thanks.</p>'],
		['a reply that starts with <invoke>', '<invoke>foo</invoke> is how the old API looked.'],
		['a tag name that only starts like one', 'Hi,\n\nsee <functional_calls> and <tool_caller>.'],
		['a reply ending in a heart', 'Love you <3'],
		['a reply ending in a comparison', 'true if a < b'],
		['a reply ending in a bold tag', 'that is <b>'],
		['a reply ending in a lone angle bracket', 'see the arrow <'],
		['a reply ending in an inner tag name', 'see <res'],
		['escaped prose', 'Use &lt;b&gt; for bold &amp; &lt;3'],
		[
			'escaped markup, which is entity text and not a call',
			'&lt;invoke name=&quot;recallKnowledge&quot;&gt;&lt;/invoke&gt;Hi John',
		],
	])('keeps %s', (_label, text) => {
		expect(stripLeakedToolMarkup(text)).toEqual({ kind: 'clean', text });
	});
});

describe('hostile input stays linear', () => {
	const shapes: Array<[string, string]> = [
		['unclosed openers', '<invoke name="recallKnowledge">'.repeat(20_000)],
		['inline openers', `x ${'<invoke name="recallKnowledge" '.repeat(20_000)}`],
		['whitespace after a tag name', `<invoke${' '.repeat(200_000)}`],
		['an endless attribute', `<invoke name="${'a'.repeat(200_000)}`],
		['angle brackets', '<'.repeat(200_000)],
		['openers in code spans', '`<tool_call>` '.repeat(20_000)],
		['openers and closers in separate spans', '`<tool_call>` `</tool_call>` '.repeat(10_000)],
		['blocks in code spans', '`<tool_call>{}</tool_call>` '.repeat(10_000)],
		['unpaired backtick runs', '` `` ``` '.repeat(30_000)],
		['near-miss container names', 'x <function_call '.repeat(20_000)],
		['closing tags in prose', `Hi ${'</invoke '.repeat(20_000)}`],
		['namespaces', '<a:b:c:d:'.repeat(20_000)],
		['a huge namespace', `<${'a'.repeat(200_000)}:invoke name="x">`],
	];
	it.each(shapes)('%s', (_label, text) => {
		const started = performance.now();
		stripLeakedToolMarkup(text);
		visibleDraftStreamText(text);
		expect(performance.now() - started).toBeLessThan(1_000);
	});
});

/** Every prefix of the text, as a stream would deliver it one character at a time. */
function everyPrefix(text: string): string[] {
	return Array.from({ length: text.length + 1 }, (_, n) => text.slice(0, n));
}

describe('visibleDraftStreamText', () => {
	it.each(PREFIXES)('never shows any part of %s, at any chunk boundary', (_label, prefix) => {
		const full = prefix + REPLY;
		for (const partial of everyPrefix(full)) {
			const visible = visibleDraftStreamText(partial);
			expect(REPLY.startsWith(visible), JSON.stringify(partial)).toBe(true);
		}
		expect(visibleDraftStreamText(full)).toBe(REPLY);
	});

	it.each([
		['plain markup', `Let me check.\n\n${ISSUE_PREFIX}${REPLY}`],
		['an inline invoke', `Let me check. <invoke name="recallKnowledge">${REPLY}`],
		['an inline container block', `${INLINE_BLOCK}${REPLY}`],
		['a container line', `Let me check.\n<tool_call>{}</tool_call>${REPLY}`],
		[
			'a block wrapped in an unclosed backtick',
			`Let me check. \`<tool_call>{}</tool_call>${REPLY}`,
		],
		['a block a stray backtick pairs into', `${STRAY_TICK_BLOCK}${REPLY}`],
		['a stray backtick and an unclosed block', `${PAYLOAD_TICK_UNCLOSED}\n${REPLY}`],
		['a stray backtick and a backtick-wrapped closer', `${PAYLOAD_TICK_SPAN}${REPLY}`],
	])('holds the text back from %s that starts after the reply', (_label, full) => {
		for (const partial of everyPrefix(full)) {
			const visible = visibleDraftStreamText(partial);
			expect(visible, JSON.stringify(partial)).not.toMatch(/<\/?(?:invoke|tool_call|function_)/);
			expect(
				full.startsWith(visible) && visible.length <= 'Let me check `availability. '.length
			).toBe(true);
		}
	});

	it('streams a plain reply as it arrives, holding back only a tag still being written', () => {
		expect(visibleDraftStreamText('Hi John,\n\nthanks')).toBe('Hi John,\n\nthanks');
		expect(visibleDraftStreamText('Hi John, <inv')).toBe('Hi John, ');
		expect(visibleDraftStreamText('Hi John, <invoke name="rec')).toBe('Hi John, ');
		expect(visibleDraftStreamText('Hi John, <3 and more')).toBe('Hi John, <3 and more');
		expect(visibleDraftStreamText('if a < b')).toBe('if a < b');
		expect(visibleDraftStreamText('Tom &amp; Jerry')).toBe('Tom &amp; Jerry');
		expect(visibleDraftStreamText('a lone </tool_call> closer')).toBe('a lone </tool_call> closer');
	});

	it('holds back a container opener wherever it sits, backticks included', () => {
		expect(visibleDraftStreamText('wrap it in `<tool_call>` tags')).toBe('wrap it in `');
		expect(visibleDraftStreamText('see `<tool_call>{}</tool_call>` ok')).toBe('see `');
		expect(visibleDraftStreamText('```\n<function_calls>\n```\nok')).toBe('```\n');
	});

	it('shows nothing while a leading block is still open or being written', () => {
		expect(visibleDraftStreamText('<function_calls>\n<invoke name="recallKnowledge">')).toBe('');
		expect(visibleDraftStreamText('<function_calls ')).toBe('');
		expect(visibleDraftStreamText('<invoke name=\n')).toBe('');
		expect(visibleDraftStreamText('  <')).toBe('');
		expect(visibleDraftStreamText('<tool_')).toBe('');
		expect(visibleDraftStreamText('</resul')).toBe('');
		expect(visibleDraftStreamText(`<${VENDOR_NS}:inv`)).toBe('');
	});
});

describe('grammar fuzz: every valid leading tag, at every chunk boundary', () => {
	let seed = 1255;
	const pick = <T>(items: readonly T[]): T => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return items[seed % items.length]!;
	};
	const reply = 'Hi Zoë 👋,\nTom &amp; Jerry &lt;b&gt; okay.\nBest';

	it('strips each one and never shows any part of it while it streams', () => {
		let leaks = 0;
		for (let round = 0; round < 300; round += 1) {
			const namespace = pick(['', 'ns:', '_a.b-c2:', `${'a'.repeat(32)}:`]);
			const tag = pick([
				'invoke',
				'tool_call',
				'tool_calls',
				'function_results',
				'function_calls',
				'tool_use',
				'tool_result',
				'parameter',
				'result',
			]);
			const name = pick([tag, tag.toUpperCase()]);
			const space = pick([' ', '\n', '\r\n', '\t', ' '.repeat(32)]);
			const quote = pick(['"', "'"]);
			const attribute = ['invoke', 'parameter'].includes(tag)
				? `${space}${pick(['name', 'NAME'])}${space}=${space}${quote}${'x'.repeat(1 + (round % 200))}${quote}`
				: '';
			const prefix = `﻿  <${namespace}${name}${attribute}${space}>payload</${namespace}${name}${space}>\n`;
			const full = prefix + reply;
			expect(stripLeakedToolMarkup(full), full).toEqual({ kind: 'stripped', text: reply });
			for (const partial of everyPrefix(full)) {
				if (!reply.startsWith(visibleDraftStreamText(partial))) leaks += 1;
			}
			expect(visibleDraftStreamText(full)).toBe(reply);
		}
		expect(leaks).toBe(0);
	}, 60_000);
});
