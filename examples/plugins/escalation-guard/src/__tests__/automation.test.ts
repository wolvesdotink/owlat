import { describe, expect, it } from 'vitest';
import type { JsonObject } from '@owlat/plugin-kit';
import { EscalationConfigError, escalationTrigger } from '../automationTrigger';
import {
	emailDomain,
	priorityAccountCondition,
	MAX_PRIORITY_DOMAINS,
} from '../automationCondition';
import { requireOwnerStep } from '../automationStep';

describe('escalation-raised automation trigger', () => {
	const config = escalationTrigger.parseConfig({ minimumLevel: 'escalate' });

	it('rejects configs it does not fully understand', () => {
		for (const raw of [
			null,
			'escalate',
			[],
			{},
			{ minimumLevel: 'none' },
			{ minimumLevel: 'ESCALATE' },
			{ minimumLevel: 1 },
		]) {
			expect(() => escalationTrigger.parseConfig(raw)).toThrow(EscalationConfigError);
		}
	});

	it('rejects a config whose value is a getter rather than data', () => {
		const raw = {};
		Object.defineProperty(raw, 'minimumLevel', { get: () => 'escalate', enumerable: true });
		expect(() => escalationTrigger.parseConfig(raw)).toThrow(EscalationConfigError);
	});

	it('rejects a config that only inherits the field', () => {
		expect(() =>
			escalationTrigger.parseConfig(Object.create({ minimumLevel: 'escalate' }))
		).toThrow(EscalationConfigError);
	});

	it('matches at and above the configured level', () => {
		expect(
			escalationTrigger.matches({ contactId: 'c1', payload: { level: 'escalate' } }, config)
		).toBe(true);
		expect(
			escalationTrigger.matches({ contactId: 'c1', payload: { level: 'watch' } }, config)
		).toBe(false);
		const watching = escalationTrigger.parseConfig({ minimumLevel: 'watch' });
		expect(
			escalationTrigger.matches({ contactId: 'c1', payload: { level: 'watch' } }, watching)
		).toBe(true);
	});

	it('treats an unknown or missing payload level as no escalation', () => {
		const payloads: readonly JsonObject[] = [
			{},
			{ level: 'critical' },
			{ level: 7 },
			{ level: null },
		];
		for (const payload of payloads) {
			expect(escalationTrigger.matches({ contactId: 'c1', payload }, config)).toBe(false);
		}
	});

	it('projects trigger data as primitives only', () => {
		const data = escalationTrigger.buildTriggerData?.(
			{ contactId: 'c1', payload: { level: 'escalate', signals: ['legal-threat', 'churn'] } },
			config
		);
		expect(data).toEqual({ escalationLevel: 'escalate', escalationSignalCount: 2 });
		for (const value of Object.values(data ?? {})) {
			expect(['string', 'number', 'boolean']).toContain(typeof value);
		}
	});

	it('reports a zero signal count when the payload has no signal array', () => {
		expect(
			escalationTrigger.buildTriggerData?.(
				{ contactId: 'c1', payload: { level: 'escalate', signals: 'legal-threat' } },
				config
			)
		).toEqual({ escalationLevel: 'escalate', escalationSignalCount: 0 });
	});
});

describe('priority-account automation condition', () => {
	const config = priorityAccountCondition.parseConfig({
		domains: ['acme.example', 'globex.example'],
	});

	it('rejects malformed or unbounded domain lists', () => {
		for (const raw of [
			null,
			{ domains: [] },
			{ domains: 'acme.example' },
			{ domains: ['ACME.example'] },
			{ domains: ['no-dot'] },
			{ domains: ['-bad.example'] },
			{ domains: [42] },
			{ domains: Array.from({ length: MAX_PRIORITY_DOMAINS + 1 }, (_, i) => `d${i}.example`) },
		]) {
			expect(() => priorityAccountCondition.parseConfig(raw)).toThrow(EscalationConfigError);
		}
	});

	it('deduplicates the configured domains', () => {
		expect(
			priorityAccountCondition.parseConfig({ domains: ['a.example', 'a.example', 'b.example'] })
				.domains
		).toEqual(['a.example', 'b.example']);
	});

	it('matches a listed domain case-insensitively on the address side', () => {
		expect(
			priorityAccountCondition.evaluate(
				{ contactEmail: 'Ceo@ACME.example', contactProperties: {} },
				config
			)
		).toBe(true);
	});

	it('does not match an unlisted or malformed address', () => {
		for (const contactEmail of ['someone@other.example', 'no-at-sign', '@acme.example', 'a@']) {
			expect(
				priorityAccountCondition.evaluate({ contactEmail, contactProperties: {} }, config)
			).toBe(false);
		}
	});

	it('does not match a subdomain of a listed domain', () => {
		expect(
			priorityAccountCondition.evaluate(
				{ contactEmail: 'ceo@mail.acme.example', contactProperties: {} },
				config
			)
		).toBe(false);
	});

	it('emailDomain returns an empty string for malformed addresses', () => {
		expect(emailDomain('a@b.example')).toBe('b.example');
		expect(emailDomain('nope')).toBe('');
		expect(emailDomain('@b.example')).toBe('');
	});
});

describe('require-owner automation step', () => {
	const config = requireOwnerStep.parseConfig({ ownerProperty: 'escalationOwner' });

	it('rejects a property name that is not a plain identifier', () => {
		for (const raw of [
			null,
			{},
			{ ownerProperty: '' },
			{ ownerProperty: '__proto__' },
			{ ownerProperty: 'owner.name' },
			{ ownerProperty: 'a'.repeat(65) },
		]) {
			expect(() => requireOwnerStep.parseConfig(raw)).toThrow(EscalationConfigError);
		}
	});

	it('completes when the contact carries a non-empty owner', async () => {
		await expect(
			requireOwnerStep.execute(
				{ contactEmail: 'ceo@acme.example', contactProperties: { escalationOwner: 'dana' } },
				config
			)
		).resolves.toEqual({ kind: 'completed' });
	});

	it('fails — never completes — when the owner is missing or blank', async () => {
		const cases: readonly JsonObject[] = [{}, { escalationOwner: '   ' }, { escalationOwner: 7 }];
		for (const contactProperties of cases) {
			const result = await requireOwnerStep.execute(
				{ contactEmail: 'ceo@acme.example', contactProperties },
				config
			);
			expect(result.kind).toBe('failed');
		}
	});

	it('ignores an inherited owner property', async () => {
		const contactProperties = Object.create({ escalationOwner: 'dana' }) as Record<string, never>;
		const result = await requireOwnerStep.execute(
			{ contactEmail: 'ceo@acme.example', contactProperties },
			config
		);
		expect(result.kind).toBe('failed');
	});

	it('can only ever produce completed or failed', async () => {
		const results = await Promise.all([
			requireOwnerStep.execute(
				{ contactEmail: 'a@acme.example', contactProperties: { escalationOwner: 'dana' } },
				config
			),
			requireOwnerStep.execute({ contactEmail: 'a@acme.example', contactProperties: {} }, config),
		]);
		expect(results.map((result) => result.kind).sort()).toEqual(['completed', 'failed']);
	});
});
