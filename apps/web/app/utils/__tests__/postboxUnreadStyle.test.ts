/**
 * Postbox unread-style derivations: a stored value normalises to a valid style
 * (defaulting to dot and weight), and the picker offers all four as catalog keys.
 *
 * The styles themselves are CSS keyed off `data-unread-style`, which happy-dom
 * cannot resolve, so the stylesheet's rules are read from source.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_UNREAD_STYLE_DEFAULT,
	POSTBOX_UNREAD_STYLE_OPTIONS,
	resolvePostboxUnreadStyle,
} from '../postboxUnreadStyle';

describe('resolvePostboxUnreadStyle', () => {
	it('defaults to dot and weight for unset values', () => {
		expect(resolvePostboxUnreadStyle(undefined)).toBe('dot-weight');
		expect(resolvePostboxUnreadStyle(null)).toBe('dot-weight');
		expect(POSTBOX_UNREAD_STYLE_DEFAULT).toBe('dot-weight');
	});

	it('passes through every valid style', () => {
		for (const style of ['weight', 'dot', 'dot-weight', 'tint']) {
			expect(resolvePostboxUnreadStyle(style)).toBe(style);
		}
	});

	it('normalises an unknown stored value to the default', () => {
		expect(resolvePostboxUnreadStyle('underline')).toBe('dot-weight');
	});
});

describe('POSTBOX_UNREAD_STYLE_OPTIONS', () => {
	it('offers all four styles, the default first, as catalog keys', () => {
		expect(POSTBOX_UNREAD_STYLE_OPTIONS.map((o) => o.value)).toEqual([
			'dot-weight',
			'dot',
			'weight',
			'tint',
		]);
		expect(POSTBOX_UNREAD_STYLE_OPTIONS.every((o) => o.label.startsWith('shared.'))).toBe(true);
	});
});

describe('postbox-unread.css', () => {
	const css = readFileSync(resolve(__dirname, '../../assets/css/postbox-unread.css'), 'utf8');
	const rule = (selector: string) => {
		const at = css.indexOf(`${selector} {`);
		expect(at, `rule for \`${selector}\``).toBeGreaterThan(-1);
		return css.slice(at, css.indexOf('}', at));
	};

	it('hides the dot unless a dot style asks for it', () => {
		expect(rule('.pbx-unread-dot')).toContain('display: none');
		expect(css).toContain("[data-unread-style='dot'] .pbx-unread-dot,");
		expect(rule("[data-unread-style='dot-weight'] .pbx-unread-dot")).toContain(
			'display: inline-block'
		);
	});

	it('drops the weight only for the dot style', () => {
		expect(rule("[data-unread-style='dot'] .pbx-unread-weight")).toContain('font-weight: inherit');
		expect(css.match(/\.pbx-unread-weight/g)).toHaveLength(1);
	});

	it('tints an unread row only for the tint style', () => {
		expect(rule("[data-unread-style='tint'] .pbx-row-link:has(.pbx-unread-dot)")).toContain(
			'background-color'
		);
	});
});
