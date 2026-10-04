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

describe('stripLeakedToolMarkup — leading prefix', () => {
	it('strips the issue example and keeps the reply after it', () => {
		expect(stripLeakedToolMarkup(ISSUE_PREFIX + REPLY)).toEqual({ kind: 'stripped', text: REPLY });
	});

	it('leaves a reply without markup untouched, byte for byte', () => {
		const text = '  Hi John,\n\nsee you then.  ';
		expect(stripLeakedToolMarkup(text)).toEqual({ kind: 'clean', text });
	});

	it('strips several call and result blocks with whitespace between them', () => {
		const text =
			'\n  <function_calls>\n<invoke name="recallKnowledge">\n<parameter name="query">a</parameter>\n</invoke>\n</function_calls>\n' +
			'<function_results>\n<result>\n<name>recallKnowledge</name>\n<output>{}</output>\n</result>\n</function_results>\n\n' +
			'<invoke name=\'recallKnowledge\'><parameter name="query">b</parameter></invoke>' +
			'<function_results>{"results":[]}</function_results>\n\n' +
			REPLY;
		expect(stripLeakedToolMarkup(text)).toEqual({ kind: 'stripped', text: REPLY });
	});

	it.each([
		[
			'tool_call',
			'<tool_call>\n{"name": "recallKnowledge", "arguments": {"query": "x"}}\n</tool_call>\n',
		],
		['tool_use', '<tool_use>{"name":"recallKnowledge"}</tool_use>'],
		['tool_calls', '<tool_calls>[{"name":"recallKnowledge"}]</tool_calls>\n'],
		['tool_result', '<tool_result>{"facts":[]}</tool_result>\n'],
		[
			'a namespaced call',
			'<ns:invoke name="recallKnowledge"><ns:parameter name="query">x</ns:parameter></ns:invoke>\n',
		],
		['a bare result block', '<result>{"facts":[]}</result>\n'],
		['a stray closing tag', '</function_results>'],
	])('strips a leading %s', (_label, prefix) => {
		expect(stripLeakedToolMarkup(prefix + REPLY)).toEqual({ kind: 'stripped', text: REPLY });
	});
});

describe('stripLeakedToolMarkup — unusable', () => {
	it('reports markup after the reply started', () => {
		const text = `Let me check availability.\n\n${ISSUE_PREFIX}${REPLY}`;
		expect(stripLeakedToolMarkup(text)).toEqual({ kind: 'unusable', reason: 'embedded' });
	});

	it('reports markup left after a stripped prefix', () => {
		const text = `${ISSUE_PREFIX}Hi John,\n<invoke name="recallKnowledge"></invoke>\nBest`;
		expect(stripLeakedToolMarkup(text)).toEqual({ kind: 'unusable', reason: 'embedded' });
	});

	it('reports a stray closing tag inside the reply', () => {
		expect(stripLeakedToolMarkup(`${REPLY}\n</function_calls>`)).toEqual({
			kind: 'unusable',
			reason: 'embedded',
		});
	});

	it('reports a block that never closes', () => {
		expect(stripLeakedToolMarkup('<invoke name="recallKnowledge">\n<parameter name="q">x')).toEqual(
			{
				kind: 'unusable',
				reason: 'unclosed',
			}
		);
	});

	it('reports a prefix with no reply after it', () => {
		expect(stripLeakedToolMarkup(`${ISSUE_PREFIX}\n \n`)).toEqual({
			kind: 'unusable',
			reason: 'empty',
		});
		expect(stripLeakedToolMarkup(`${ISSUE_PREFIX}<func`)).toEqual({
			kind: 'unusable',
			reason: 'empty',
		});
	});
});

describe('stripLeakedToolMarkup — prose is not markup', () => {
	it.each([
		[
			'a bare <parameter> in a code sample',
			'Hi,\n\nadd `<parameter>` to the config:\n<parameter>30</parameter>\n\nBest',
		],
		[
			'a named <parameter> inside the reply',
			'Hi,\n\nset it like this:\n<parameter name="timeout">30</parameter>\n\nBest',
		],
		['a <result> element inside the reply', 'Hi,\n\nthe API answers with <result>ok</result>.'],
		['an <invoke> without a name', 'Hi,\n\nthe <invoke> element is deprecated.'],
		['comparison signs and arrows', 'Hi,\n\nif a < b and c > d -> ok <3'],
		['an HTML-looking reply', '<p>Hi John,</p>\n<p>thanks.</p>'],
		['a tag name that only starts like one', 'Hi,\n\nsee <functional_calls> and <tool_caller>.'],
	])('keeps %s', (_label, text) => {
		expect(stripLeakedToolMarkup(text)).toEqual({ kind: 'clean', text });
	});
});

describe('stripLeakedToolMarkup — hostile input stays linear', () => {
	const shapes: Array<[string, string]> = [
		['unclosed openers', '<invoke name="recallKnowledge">'.repeat(20_000)],
		['whitespace after a tag name', `<invoke${' '.repeat(200_000)}`],
		['an endless attribute', `<invoke name="${'a'.repeat(200_000)}`],
		['angle brackets', '<'.repeat(200_000)],
		['near-miss container names', 'x <function_call '.repeat(20_000)],
		['closing tags in prose', `Hi ${'</invoke '.repeat(20_000)}`],
		['namespaces', '<a:b:c:d:'.repeat(20_000)],
	];
	it.each(shapes)('%s', (_label, text) => {
		const started = performance.now();
		stripLeakedToolMarkup(text);
		visibleDraftStreamText(text);
		expect(performance.now() - started).toBeLessThan(1_000);
	});
});

describe('visibleDraftStreamText', () => {
	/** Every prefix of the text, as a stream would deliver it one character at a time. */
	function everyPrefix(text: string): string[] {
		return Array.from({ length: text.length + 1 }, (_, n) => text.slice(0, n));
	}

	it('never shows any part of a leading markup prefix', () => {
		const full = ISSUE_PREFIX + REPLY;
		for (const partial of everyPrefix(full)) {
			const visible = visibleDraftStreamText(partial);
			expect(REPLY.startsWith(visible), JSON.stringify(partial)).toBe(true);
		}
		expect(visibleDraftStreamText(full)).toBe(REPLY);
	});

	it('streams a plain reply as it arrives, holding back only a tag still being written', () => {
		expect(visibleDraftStreamText('Hi John,\n\nthanks')).toBe('Hi John,\n\nthanks');
		expect(visibleDraftStreamText('Hi John, <inv')).toBe('Hi John, ');
		expect(visibleDraftStreamText('Hi John, <invoke name="rec')).toBe('Hi John, ');
		expect(visibleDraftStreamText('Hi John, <3 and more')).toBe('Hi John, <3 and more');
		expect(visibleDraftStreamText('if a < b')).toBe('if a < b');
	});

	it('freezes the text before markup that starts after the reply', () => {
		const full = `Let me check.\n\n${ISSUE_PREFIX}${REPLY}`;
		for (const partial of everyPrefix(full)) {
			const visible = visibleDraftStreamText(partial);
			expect(visible).not.toMatch(/<\/?(?:invoke|parameter|function_)/);
			expect('Let me check.\n\n'.startsWith(visible), JSON.stringify(partial)).toBe(true);
		}
	});

	it('shows nothing while a leading block is still open', () => {
		expect(visibleDraftStreamText('<function_calls>\n<invoke name="recallKnowledge">')).toBe('');
		expect(visibleDraftStreamText('  <')).toBe('');
		expect(visibleDraftStreamText('<tool_')).toBe('');
	});
});
