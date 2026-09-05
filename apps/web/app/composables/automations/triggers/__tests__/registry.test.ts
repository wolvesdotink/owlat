import { describe, it, expect } from 'vitest';
import { TRIGGER_EDITOR_MODULES, triggerEditorModuleFor, listTriggerEditorModules } from '../index';
import { createTestI18n, localizedWith } from '~/__tests__/i18n';

/**
 * Trigger modules cannot call `useI18n`, so every label, error and summary they
 * hand back is a message KEY (or a key plus its interpolations) that the
 * renderer translates. `resolves` asserts the catalog carries it: a key that
 * resolves to itself is a trigger whose copy would paint as a raw path.
 */
const { t, te } = createTestI18n().global;
const resolves = (key: string) => te(key) && t(key) !== key;
/** What a renderer does with a registry message. */
const render = localizedWith(t);
/** The display context every trigger takes, empty where the trigger ignores it. */
const computedTopics = { value: [] } as never;

describe('Trigger editor module registry', () => {
	it('contains exactly the four canonical trigger kinds', () => {
		expect(Object.keys(TRIGGER_EDITOR_MODULES).sort()).toEqual([
			'contact_created',
			'contact_updated',
			'event_received',
			'topic_subscribed',
		]);
	});

	it('every entry self-reports its own kind', () => {
		for (const [key, module] of Object.entries(TRIGGER_EDITOR_MODULES)) {
			expect(module.kind).toBe(key);
		}
	});

	it('triggerEditorModuleFor narrows to the requested kind', () => {
		expect(triggerEditorModuleFor('contact_created').kind).toBe('contact_created');
		expect(triggerEditorModuleFor('contact_updated').kind).toBe('contact_updated');
		expect(triggerEditorModuleFor('event_received').kind).toBe('event_received');
		expect(triggerEditorModuleFor('topic_subscribed').kind).toBe('topic_subscribed');
	});

	it('listTriggerEditorModules iterates the registry', () => {
		expect(
			listTriggerEditorModules()
				.map((m) => m.kind)
				.sort()
		).toEqual(['contact_created', 'contact_updated', 'event_received', 'topic_subscribed']);
	});

	it('only contact_created has requiresConfig=false', () => {
		expect(triggerEditorModuleFor('contact_created').requiresConfig).toBe(false);
		expect(triggerEditorModuleFor('contact_updated').requiresConfig).toBe(true);
		expect(triggerEditorModuleFor('event_received').requiresConfig).toBe(true);
		expect(triggerEditorModuleFor('topic_subscribed').requiresConfig).toBe(true);
	});

	it('only contact_created omits the EditorComponent', () => {
		expect(triggerEditorModuleFor('contact_created').EditorComponent).toBeNull();
		expect(triggerEditorModuleFor('contact_updated').EditorComponent).not.toBeNull();
		expect(triggerEditorModuleFor('event_received').EditorComponent).not.toBeNull();
		expect(triggerEditorModuleFor('topic_subscribed').EditorComponent).not.toBeNull();
	});
});

describe('contactCreatedTriggerEditorModule', () => {
	const module = triggerEditorModuleFor('contact_created');

	it('createDefault returns null (no config)', () => {
		expect(module.createDefault()).toBeNull();
	});

	it('validateForSubmit always passes', () => {
		expect(module.validateForSubmit(null)).toBeNull();
	});

	it('getSummary and the registry copy resolve in the catalog', () => {
		expect(module.getSummary(null, { topics: computedTopics })).toBe(
			'shared.automations.triggers.contactCreated.summary'
		);
		expect(resolves(module.label)).toBe(true);
		expect(resolves(module.description)).toBe(true);
		expect(resolves('shared.automations.triggers.contactCreated.summary')).toBe(true);
	});
});

describe('contactUpdatedTriggerEditorModule', () => {
	const module = triggerEditorModuleFor('contact_updated');

	it('createDefault returns empty propertyKey', () => {
		expect(module.createDefault()).toEqual({ propertyKey: '' });
	});

	it('validateForSubmit flags missing propertyKey', () => {
		expect(module.validateForSubmit({ propertyKey: '' })).toBe(
			'shared.automations.triggers.contactUpdated.propertyRequired'
		);
		expect(module.validateForSubmit({ propertyKey: 'email' })).toBeNull();
	});

	it('getSummary carries the watched property as an interpolation', () => {
		expect(module.getSummary({ propertyKey: '' }, { topics: computedTopics })).toBe(
			'shared.automations.triggers.contactUpdated.summaryAny'
		);
		expect(module.getSummary({ propertyKey: 'plan' }, { topics: computedTopics })).toEqual({
			key: 'shared.automations.triggers.contactUpdated.summary',
			params: { property: 'plan' },
		});
		expect(render(module.getSummary({ propertyKey: 'plan' }, { topics: computedTopics }))).toBe(
			'When plan changes'
		);
	});

	it('every message it can hand back is in the catalog', () => {
		expect(resolves(module.label)).toBe(true);
		expect(resolves(module.description)).toBe(true);
		expect(resolves('shared.automations.triggers.contactUpdated.propertyRequired')).toBe(true);
		expect(resolves('shared.automations.triggers.contactUpdated.summaryAny')).toBe(true);
	});
});

describe('eventReceivedTriggerEditorModule', () => {
	const module = triggerEditorModuleFor('event_received');

	it('createDefault returns empty eventName', () => {
		expect(module.createDefault()).toEqual({ eventName: '' });
	});

	it('validateForSubmit flags empty and whitespace-only event names', () => {
		expect(module.validateForSubmit({ eventName: '' })).toBe(
			'shared.automations.triggers.eventReceived.eventNameRequired'
		);
		expect(module.validateForSubmit({ eventName: '   ' })).toBe(
			'shared.automations.triggers.eventReceived.eventNameRequired'
		);
		expect(module.validateForSubmit({ eventName: 'user.signed_up' })).toBeNull();
	});

	it('getSummary carries the event name as an interpolation', () => {
		expect(module.getSummary({ eventName: '' }, { topics: computedTopics })).toBe(
			'shared.automations.triggers.eventReceived.summaryAny'
		);
		expect(
			render(module.getSummary({ eventName: 'user.signed_up' }, { topics: computedTopics }))
		).toBe('Event: user.signed_up');
	});

	it('every message it can hand back is in the catalog', () => {
		expect(resolves(module.label)).toBe(true);
		expect(resolves(module.description)).toBe(true);
		expect(resolves('shared.automations.triggers.eventReceived.eventNameRequired')).toBe(true);
		expect(resolves('shared.automations.triggers.eventReceived.summaryAny')).toBe(true);
	});
});

describe('topicSubscribedTriggerEditorModule', () => {
	const module = triggerEditorModuleFor('topic_subscribed');

	it('createDefault returns empty topicId', () => {
		expect(module.createDefault()).toEqual({ topicId: '' });
	});

	it('validateForSubmit flags missing topicId', () => {
		expect(module.validateForSubmit({ topicId: '' })).toBe(
			'shared.automations.triggers.topicSubscribed.topicRequired'
		);
		expect(module.validateForSubmit({ topicId: 't1' })).toBeNull();
	});

	it('getSummary names the subscribed topic, or says it is unknown', () => {
		const topics = { value: [{ _id: 't1', name: 'Product news' }] } as never;
		expect(module.getSummary({ topicId: '' }, { topics })).toBe(
			'shared.automations.triggers.topicSubscribed.summaryAny'
		);
		expect(render(module.getSummary({ topicId: 't1' }, { topics }))).toBe('Topic: Product news');
		expect(module.getSummary({ topicId: 'gone' }, { topics })).toBe(
			'shared.automations.triggers.topicSubscribed.summaryUnknown'
		);
	});

	it('every message it can hand back is in the catalog', () => {
		expect(resolves(module.label)).toBe(true);
		expect(resolves(module.description)).toBe(true);
		expect(resolves('shared.automations.triggers.topicSubscribed.topicRequired')).toBe(true);
		expect(resolves('shared.automations.triggers.topicSubscribed.summaryAny')).toBe(true);
		expect(resolves('shared.automations.triggers.topicSubscribed.summaryUnknown')).toBe(true);
	});
});
