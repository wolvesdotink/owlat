/**
 * The automation row's verbs: what each status and role may do, in menu order.
 * The context menu renders them all; the overflow menu leaves out the ones the
 * row already shows as a control of its own.
 */
import { describe, expect, it } from 'vitest';
import { automationOverflowVerbs, automationRowVerbs } from '../automationRowVerbs';

const ids = (status: 'draft' | 'active' | 'paused', canManage: boolean) =>
	automationRowVerbs(status, canManage).map((verb) => verb.id);

describe('automationRowVerbs', () => {
	it('gives a manager every verb a status allows', () => {
		expect(ids('active', true)).toEqual(['view', 'edit', 'duplicate', 'toggle']);
		expect(ids('paused', true)).toEqual(['view', 'edit', 'duplicate', 'toggle', 'delete']);
		// A draft has never run: no analytics to view and nothing to pause.
		expect(ids('draft', true)).toEqual(['edit', 'duplicate', 'delete']);
	});

	it('leaves an editor only the detail view, which a draft does not have', () => {
		expect(ids('active', false)).toEqual(['view']);
		expect(ids('draft', false)).toEqual([]);
	});

	it('labels the toggle by what it will do and fences delete off', () => {
		const active = automationRowVerbs('active', true).find((v) => v.id === 'toggle');
		const paused = automationRowVerbs('paused', true).find((v) => v.id === 'toggle');
		expect(active?.labelKey).toBe('dashboard.automations.index.actions.pause');
		expect(paused?.labelKey).toBe('dashboard.automations.index.actions.resume');
		const remove = automationRowVerbs('paused', true).find((v) => v.id === 'delete');
		expect(remove).toMatchObject({ danger: true, separatorBefore: true });
	});
});

describe('automationOverflowVerbs', () => {
	const overflow = (status: 'draft' | 'active' | 'paused', canManage: boolean) =>
		automationOverflowVerbs(status, canManage).map((verb) => verb.id);

	it('leaves out what the name link, the pencil and the switch already do', () => {
		expect(overflow('active', true)).toEqual(['duplicate']);
		expect(overflow('paused', true)).toEqual(['duplicate', 'delete']);
		expect(overflow('draft', true)).toEqual(['duplicate', 'delete']);
	});

	it('leaves an editor nothing, since the name already opens the detail page', () => {
		expect(overflow('active', false)).toEqual([]);
		expect(overflow('paused', false)).toEqual([]);
		expect(overflow('draft', false)).toEqual([]);
	});
});
