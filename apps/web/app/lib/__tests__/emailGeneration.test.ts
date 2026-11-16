import { describe, expect, it } from 'vitest';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import type { Permission } from '@owlat/shared/organizationPermissions';
import type { OperationError } from '@owlat/shared/operationError';
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';
import {
	addReference,
	classifyGenerationFailure,
	draftPath,
	EXAMPLE_PROMPT_KEYS,
	FAILURE_KEYS,
	generationRequest,
	MAX_PROMPT_CHARS,
	MAX_REFERENCES,
	nextSubmission,
	removeReference,
	type EmailReference,
} from '../emailGeneration';
import { generationEntry } from '../emailGenerationEntry';

const env = (flags: readonly FeatureFlagKey[], permissions: readonly Permission[]) => ({
	isFeatureEnabled: (flag: FeatureFlagKey) => flags.includes(flag),
	can: (permission: Permission) => permissions.includes(permission),
});
const admin: Permission[] = ['templates:manage', 'campaigns:manage', 'settings:manage'];
const editor: Permission[] = ['campaigns:manage'];
const on: FeatureFlagKey[] = ['ai', 'ai.emailGeneration', 'campaigns', 'transactional'];

describe('generationEntry', () => {
	it('shows the generator to a member who may create the draft', () => {
		expect(generationEntry('template', env(on, admin))).toBe('show');
		expect(generationEntry('transactional', env(on, admin))).toBe('show');
		expect(generationEntry('campaign', env(on, admin))).toBe('show');
	});

	it('hides it from an editor, who may not create templates', () => {
		expect(generationEntry('template', env(on, editor))).toBe('hidden');
		expect(generationEntry('campaign', env(on, editor))).toBe('hidden');
	});

	it('points an admin to the Features page while the flag is off, and shows editors nothing', () => {
		const off: FeatureFlagKey[] = ['campaigns', 'transactional'];
		expect(generationEntry('template', env(off, admin))).toBe('enable_hint');
		expect(generationEntry('template', env(off, ['templates:manage']))).toBe('hidden');
		expect(generationEntry('campaign', env(off, editor))).toBe('hidden');
	});

	it('is hidden where the kind itself is off', () => {
		expect(generationEntry('transactional', env(['ai', 'ai.emailGeneration'], admin))).toBe(
			'hidden'
		);
		expect(generationEntry('campaign', env(['ai', 'ai.emailGeneration'], admin))).toBe('hidden');
	});
});

describe('references', () => {
	const ref = (id: string): EmailReference => ({ kind: 'template', id, name: id });

	it('adds without duplicates and stops at the cap', () => {
		let list: EmailReference[] = [];
		list = addReference(list, ref('a'));
		list = addReference(list, ref('a'));
		expect(list).toHaveLength(1);
		for (const id of ['b', 'c', 'd']) list = addReference(list, ref(id));
		expect(list.map((r) => r.id)).toEqual(['a', 'b', 'c']);
		expect(list).toHaveLength(MAX_REFERENCES);
		expect(removeReference(list, 'b').map((r) => r.id)).toEqual(['a', 'c']);
	});
});

describe('generationRequest', () => {
	const form = { prompt: '  A booking confirmation  ', references: [], matchStyle: true };

	it('trims the prompt and sends only ids for the references', () => {
		const request = generationRequest('transactional', {
			...form,
			references: [{ kind: 'campaign', id: 'c1', name: 'Spring' }],
			name: '  ',
			slug: 'booking',
			defaultLanguage: 'de',
		});
		expect(request).toEqual({
			ok: true,
			args: {
				kind: 'transactional',
				prompt: 'A booking confirmation',
				references: [{ kind: 'campaign', id: 'c1' }],
				matchStyle: true,
				defaultLanguage: 'de',
				slug: 'booking',
			},
		});
	});

	it('refuses an empty or oversized prompt before anything is sent', () => {
		expect(generationRequest('template', { ...form, prompt: '   ' })).toEqual({
			ok: false,
			reason: 'empty',
		});
		expect(
			generationRequest('template', { ...form, prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) })
		).toEqual({ ok: false, reason: 'too_long' });
	});
});

describe('nextSubmission', () => {
	const form = {
		prompt: 'A booking confirmation',
		references: [{ kind: 'template' as const, id: 'r1', name: 'Old' }],
		matchStyle: true,
		defaultLanguage: 'en',
		name: 'Booking',
		slug: 'booking',
	};
	const argsOf = (
		over: Partial<typeof form> = {},
		kind: 'template' | 'transactional' = 'transactional'
	) => {
		const request = generationRequest(kind, { ...form, ...over });
		if (!request.ok) throw new Error('expected a request');
		return request.args;
	};
	let minted = 0;
	const mint = () => `id-${++minted}`;

	it('mints an id for a first submission', () => {
		expect(nextSubmission(null, argsOf(), mint).requestId).toMatch(/^id-/);
	});

	it('keeps the id when the same form is sent again', () => {
		const first = nextSubmission(null, argsOf(), mint);
		expect(nextSubmission(first, argsOf(), mint).requestId).toBe(first.requestId);
		// Whitespace the request trims away is not a change.
		expect(nextSubmission(first, argsOf({ prompt: '  A booking confirmation ' }), mint)).toBe(
			first
		);
	});

	it.each([
		['prompt', { prompt: 'A password reset' }],
		['references', { references: [] }],
		['style switch', { matchStyle: false }],
		['language', { defaultLanguage: 'de' }],
		['name', { name: 'Meeting booked' }],
		['slug', { slug: 'meeting-booked' }],
	] as const)('mints a new id once the %s changes', (_label, over) => {
		const first = nextSubmission(null, argsOf(), mint);
		expect(nextSubmission(first, argsOf(over), mint).requestId).not.toBe(first.requestId);
	});

	it('mints a new id for another kind', () => {
		const first = nextSubmission(null, argsOf({}, 'transactional'), mint);
		expect(nextSubmission(first, argsOf({}, 'template'), mint).requestId).not.toBe(first.requestId);
	});
});

describe('classifyGenerationFailure', () => {
	const error = (over: Partial<OperationError>): OperationError => ({
		category: 'internal',
		message: 'x',
		...over,
	});

	it('names every refusal the backend sends', () => {
		expect(
			classifyGenerationFailure(
				error({
					category: 'forbidden',
					data: { code: 'AI_BUDGET_EXHAUSTED', reason: 'daily_ceiling' },
				})
			)
		).toEqual({ kind: 'budget', reason: 'daily_ceiling' });
		expect(classifyGenerationFailure(error({ category: 'rate_limited' }))).toEqual({
			kind: 'rate_limited',
		});
		expect(
			classifyGenerationFailure(
				error({ category: 'invalid_state', data: { code: 'AI_NOT_CONFIGURED' } })
			)
		).toEqual({ kind: 'not_configured' });
		expect(
			classifyGenerationFailure(
				error({
					category: 'forbidden',
					data: { feature: 'ai.emailGeneration', features: ['ai.emailGeneration'] },
				})
			)
		).toEqual({ kind: 'feature_off' });
		expect(
			classifyGenerationFailure(
				error({ category: 'forbidden', data: { code: 'EMAIL_GENERATION_FORBIDDEN' } })
			)
		).toEqual({ kind: 'permission' });
		expect(
			classifyGenerationFailure(
				error({
					category: 'invalid_state',
					data: { code: 'EMAIL_GENERATION_REFERENCE_MISSING', referenceId: 'r1' },
				})
			)
		).toEqual({ kind: 'reference_missing', referenceId: 'r1' });
		expect(
			classifyGenerationFailure(
				error({ category: 'invalid_state', data: { code: 'EMAIL_GENERATION_INVALID_OUTPUT' } })
			)
		).toEqual({ kind: 'invalid_output' });
		expect(classifyGenerationFailure(error({ category: 'already_exists' }))).toEqual({
			kind: 'slug_taken',
		});
		expect(classifyGenerationFailure(error({ category: 'network' }))).toEqual({ kind: 'network' });
		expect(classifyGenerationFailure(error({}))).toEqual({ kind: 'unknown' });
	});
});

describe('copy', () => {
	it('resolves every failure, example and kind string in both catalogs', () => {
		const lookup = (catalog: unknown, key: string): unknown =>
			key
				.split('.')
				.reduce<unknown>(
					(node, part) => (node as Record<string, unknown> | undefined)?.[part],
					catalog
				);
		for (const catalog of [en, de]) {
			const keys = [
				...Object.values(FAILURE_KEYS),
				'components.ai.emailGenerate.errors.invalidInput',
				...Object.values(EXAMPLE_PROMPT_KEYS)
					.flat()
					.flatMap((key) => [`${key}.label`, `${key}.prompt`]),
				...(['template', 'transactional', 'campaign'] as const).flatMap((kind) => [
					`components.ai.emailGenerate.title.${kind}`,
					`components.ai.emailGenerate.summary.${kind}`,
					`components.ai.emailGenerate.promptPlaceholder.${kind}`,
				]),
			];
			expect(keys.filter((key) => typeof lookup(catalog, key) !== 'string')).toEqual([]);
		}
	});

	it('includes a booking confirmation among the transactional examples', () => {
		expect(EXAMPLE_PROMPT_KEYS.transactional).toContain(
			'components.ai.emailGenerate.examples.booking'
		);
	});
});

describe('draftPath', () => {
	it('opens a template or transactional email in its editor, a campaign on Setup', () => {
		expect(draftPath({ kind: 'template', templateId: 't1' })).toBe(
			'/dashboard/send/emails/t1/edit'
		);
		expect(draftPath({ kind: 'transactional', transactionalEmailId: 'e1' })).toBe(
			'/dashboard/send/transactional/e1/edit'
		);
		expect(draftPath({ kind: 'campaign', campaignId: 'c1' })).toBe(
			'/dashboard/campaigns/new?id=c1&step=setup'
		);
	});
});
