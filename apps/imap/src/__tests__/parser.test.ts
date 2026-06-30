/**
 * Tests for the IMAP4rev1 line parser.
 *
 * Covers tag/command tokenization, quoted strings, parenthesized lists,
 * UID set parsing, and the trailing-CRLF normalization that the connection
 * loop depends on.
 */

import { describe, it, expect } from 'vitest';
import {
	parseLine,
	parseList,
	parseUidSet,
	unwrapParens,
	matchTrailingLiteral,
	parseCommandWithLiterals,
} from '../parser.js';

describe('parseLine — basic command shape', () => {
	it('returns null for empty input', () => {
		expect(parseLine('')).toBeNull();
		expect(parseLine('\r\n')).toBeNull();
	});

	it('returns null for single-token input (no command)', () => {
		expect(parseLine('a001')).toBeNull();
	});

	it('parses CAPABILITY command', () => {
		expect(parseLine('a001 CAPABILITY')).toEqual({
			tag: 'a001',
			command: 'CAPABILITY',
			args: [],
		});
	});

	it('uppercases the command keyword', () => {
		expect(parseLine('a001 noop')?.command).toBe('NOOP');
		expect(parseLine('a001 Login alice pw')?.command).toBe('LOGIN');
	});

	it('preserves the tag case verbatim', () => {
		expect(parseLine('TAG.42 NOOP')?.tag).toBe('TAG.42');
	});

	it('strips a single trailing CR/LF', () => {
		expect(parseLine('a001 NOOP\r\n')?.command).toBe('NOOP');
		expect(parseLine('a001 NOOP\n')?.command).toBe('NOOP');
	});
});

describe('parseLine — quoted strings', () => {
	it('treats "user@host" as a single token without the quotes', () => {
		expect(parseLine('a001 LOGIN "alice@example.com" "secret"')).toEqual({
			tag: 'a001',
			command: 'LOGIN',
			args: ['alice@example.com', 'secret'],
		});
	});

	it('handles backslash escapes within quoted strings', () => {
		expect(
			parseLine('a001 LOGIN "name with \\"quotes\\"" "pw"')?.args,
		).toEqual(['name with "quotes"', 'pw']);
	});

	it('preserves embedded spaces in quoted folder names', () => {
		expect(
			parseLine('a001 SELECT "[Gmail]/All Mail"')?.args,
		).toEqual(['[Gmail]/All Mail']);
	});
});

describe('parseLine — parenthesized lists', () => {
	it('keeps a top-level paren list as one opaque token', () => {
		const result = parseLine('a001 FETCH 1:* (FLAGS UID INTERNALDATE)');
		expect(result?.command).toBe('FETCH');
		expect(result?.args).toEqual(['1:*', '(FLAGS UID INTERNALDATE)']);
	});

	it('handles nested parens in BODYSTRUCTURE-style requests', () => {
		const result = parseLine('a001 FETCH 1 (BODY[HEADER.FIELDS (DATE FROM)])');
		expect(result?.args).toEqual([
			'1',
			'(BODY[HEADER.FIELDS (DATE FROM)])',
		]);
	});

	it('separates multiple paren args at top-level whitespace', () => {
		const result = parseLine('a001 STORE 1 +FLAGS (\\Seen) (UID 42)');
		// Tokens after STORE: '1', '+FLAGS', '(\\Seen)', '(UID 42)'
		expect(result?.args.length).toBe(4);
		expect(result?.args[0]).toBe('1');
		expect(result?.args[2]).toBe('(\\Seen)');
		expect(result?.args[3]).toBe('(UID 42)');
	});
});

describe('unwrapParens', () => {
	it('removes outer parens', () => {
		expect(unwrapParens('(FLAGS UID)')).toBe('FLAGS UID');
	});

	it('leaves non-paren tokens alone', () => {
		expect(unwrapParens('FLAGS')).toBe('FLAGS');
	});

	it('only strips one layer', () => {
		expect(unwrapParens('((nested))')).toBe('(nested)');
	});
});

describe('parseList', () => {
	it('splits a paren list on whitespace', () => {
		expect(parseList('(FLAGS UID INTERNALDATE)')).toEqual([
			'FLAGS',
			'UID',
			'INTERNALDATE',
		]);
	});

	it('handles tabs and multiple spaces', () => {
		expect(parseList('(FLAGS\tUID  INTERNALDATE)')).toEqual([
			'FLAGS',
			'UID',
			'INTERNALDATE',
		]);
	});

	it('returns an empty list for empty parens', () => {
		expect(parseList('()')).toEqual([]);
	});

	it('accepts unwrapped strings too', () => {
		expect(parseList('FLAGS UID')).toEqual(['FLAGS', 'UID']);
	});
});

describe('matchTrailingLiteral', () => {
	it('matches a synchronizing {N} at end of line', () => {
		expect(matchTrailingLiteral('a LOGIN {4}')).toEqual({
			octets: 4,
			literalPlus: false,
		});
	});

	it('matches a LITERAL+ {N+} at end of line', () => {
		expect(matchTrailingLiteral('a LOGIN {4+}')).toEqual({
			octets: 4,
			literalPlus: true,
		});
	});

	it('returns null when the literal is not the last token', () => {
		expect(matchTrailingLiteral('a LOGIN {4} trailing')).toBeNull();
	});

	it('returns null when there is no literal', () => {
		expect(matchTrailingLiteral('a NOOP')).toBeNull();
	});
});

describe('parseCommandWithLiterals', () => {
	it('splices LOGIN literal values back as tokens', () => {
		// `a LOGIN {4}` user `{8}` password → segments stripped of the {N} token.
		const parsed = parseCommandWithLiterals(
			['a LOGIN ', ' ', ''],
			['user', 'password'],
		);
		expect(parsed).toEqual({
			tag: 'a',
			command: 'LOGIN',
			args: ['user', 'password'],
		});
	});

	it('uppercases the command and preserves literal contents verbatim', () => {
		const parsed = parseCommandWithLiterals(
			['a login ', ''],
			['p a s s'],
		);
		expect(parsed?.command).toBe('LOGIN');
		// A literal stands as ONE opaque token even with embedded spaces.
		expect(parsed?.args).toEqual(['p a s s']);
	});

	it('returns null without tag + command', () => {
		expect(parseCommandWithLiterals([''], [])).toBeNull();
	});
});

describe('parseUidSet', () => {
	it('parses a single UID', () => {
		expect(parseUidSet('5', 100)).toEqual([[5, 5]]);
	});

	it('parses a closed range', () => {
		expect(parseUidSet('1:10', 100)).toEqual([[1, 10]]);
	});

	it('expands the * wildcard to maxUid in the upper bound', () => {
		expect(parseUidSet('5:*', 100)).toEqual([[5, 100]]);
	});

	it('expands * in the lower bound (and normalizes order)', () => {
		expect(parseUidSet('*:5', 100)).toEqual([[5, 100]]);
	});

	it('parses comma-separated specs', () => {
		expect(parseUidSet('1,5,10:12', 100)).toEqual([
			[1, 1],
			[5, 5],
			[10, 12],
		]);
	});

	it('skips malformed parts instead of throwing', () => {
		expect(parseUidSet('5,abc,7', 100)).toEqual([
			[5, 5],
			[7, 7],
		]);
	});

	it('normalizes reversed ranges (high:low → [low, high])', () => {
		expect(parseUidSet('10:5', 100)).toEqual([[5, 10]]);
	});
});
