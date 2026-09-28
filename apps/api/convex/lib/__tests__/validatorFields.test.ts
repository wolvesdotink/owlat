import {
	v,
	type Infer,
	type ObjectType,
	type PropertyValidators,
	type ValidatorJSON,
	type VObject,
} from 'convex/values';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { omit, optionalFields, pick } from '../validators/fields';
import { voiceProfileValidator } from '../validators/mailAi';
import { buildVoiceGuidance, type VoiceProfile } from '../../mail/ai/voiceProfileText';
import schema from '../../schema';
import { updateConfig } from '../../agentConfigMutations';
import { upsert as upsertVacationResponder } from '../../mail/vacation';

const fields = {
	name: v.string(),
	count: v.number(),
	note: v.optional(v.string()),
	createdAt: v.number(),
};

type ObjectJson = {
	type: 'object';
	value: Record<string, { fieldType: ValidatorJSON; optional: boolean }>;
};

/** The document type an object validator over these fields accepts. */
type ObjectOf<F extends PropertyValidators> = Infer<VObject<ObjectType<F>, F>>;

/** A validator's wire JSON (the `json` getter is not in Convex's public types). */
function jsonOf(validator: unknown): ValidatorJSON {
	return (validator as { json: ValidatorJSON }).json;
}

/** The argument validator JSON a registered Convex function exposes. */
function argsJson(fn: unknown): ObjectJson {
	return JSON.parse((fn as { exportArgs: () => string }).exportArgs()) as ObjectJson;
}

describe('pick', () => {
	it('keeps only the named fields, in the order given, as the same validators', () => {
		const picked = pick(fields, ['note', 'name']);
		expect(Object.keys(picked)).toEqual(['note', 'name']);
		expect(picked.name).toBe(fields.name);
		expect(picked.note).toBe(fields.note);
		expectTypeOf<ObjectOf<typeof picked>>().toEqualTypeOf<{
			name: string;
			note?: string;
		}>();
	});

	it('refuses a key the record does not have', () => {
		expect(() => pick(fields, ['missing' as 'name'])).toThrow('pick: unknown field "missing"');
	});
});

describe('omit', () => {
	it('drops the named fields and keeps the rest in record order', () => {
		const rest = omit(fields, ['createdAt', 'count']);
		expect(Object.keys(rest)).toEqual(['name', 'note']);
		expect(rest.name).toBe(fields.name);
		expectTypeOf<ObjectOf<typeof rest>>().toEqualTypeOf<{
			name: string;
			note?: string;
		}>();
	});

	it('refuses a key the record does not have', () => {
		expect(() => omit(fields, ['missing' as 'name'])).toThrow('omit: unknown field "missing"');
	});
});

describe('optionalFields', () => {
	it('wraps each required field in v.optional and keeps an optional one as is', () => {
		const optional = optionalFields(fields);
		expect(Object.keys(optional)).toEqual(Object.keys(fields));
		for (const validator of Object.values(optional)) expect(validator.isOptional).toBe('optional');
		expect(optional.note).toBe(fields.note);
		expect(optional.name).not.toBe(fields.name);
		expect(optional.name.kind).toBe('string');
		expect(jsonOf(v.object(optional))).toEqual(
			jsonOf(
				v.object({
					name: v.optional(v.string()),
					count: v.optional(v.number()),
					note: v.optional(v.string()),
					createdAt: v.optional(v.number()),
				})
			)
		);
		expectTypeOf<ObjectOf<typeof optional>>().toEqualTypeOf<{
			name?: string;
			count?: number;
			note?: string;
			createdAt?: number;
		}>();
	});

	it('leaves the source record untouched', () => {
		optionalFields(fields);
		expect(fields.name.isOptional).toBe('required');
	});
});

describe('function arguments derived from a table record', () => {
	it('updateConfig takes the twelve tuning fields, all optional, and never the reply mode', () => {
		const args = argsJson(updateConfig).value;
		expect(Object.keys(args).sort()).toEqual(
			[
				'autoSendDelayMs',
				'coalesceWindowMs',
				'confidenceThreshold',
				'humanApproveUndoDelayMs',
				'isWorkingHoursEnabled',
				'maxDailyAutoReplies',
				'signatureTemplate',
				'toneDescription',
				'workingHoursDays',
				'workingHoursEnd',
				'workingHoursStart',
				'workingHoursTimezone',
			].sort()
		);
		for (const field of Object.values(args)) expect(field.optional).toBe(true);
	});

	it('vacation upsert accepts an omitted replyIntervalDays although the column is required', () => {
		const args = argsJson(upsertVacationResponder).value;
		expect(args['replyIntervalDays']).toEqual({ fieldType: { type: 'number' }, optional: true });
		expect(args['subject']).toEqual({ fieldType: { type: 'string' }, optional: false });
		expect(args).not.toHaveProperty('createdAt');
	});
});

describe('VoiceProfile', () => {
	it('is the type the stored validator infers, and what buildVoiceGuidance accepts', () => {
		expectTypeOf<VoiceProfile>().toEqualTypeOf<Infer<typeof voiceProfileValidator>>();
		expectTypeOf<NonNullable<Parameters<typeof buildVoiceGuidance>[0]>>().toEqualTypeOf<
			Infer<typeof voiceProfileValidator>
		>();

		const profile = {
			greetings: ['Hi'],
			signOffs: ['Cheers'],
			formality: 2,
			brevity: 2,
			languages: ['English'],
			isEmojiUser: false,
			examplePhrasings: ['sounds good'],
		} satisfies Infer<typeof voiceProfileValidator>;
		expect(buildVoiceGuidance(profile)).toContain('Cheers');
	});

	it('is the shape the mailVoiceProfiles table stores', () => {
		const table = (schema.tables as unknown as Record<string, { validator: { json: ObjectJson } }>)[
			'mailVoiceProfiles'
		]!;
		expect(table.validator.json.value['profile']).toEqual({
			fieldType: jsonOf(voiceProfileValidator),
			optional: true,
		});
	});
});
