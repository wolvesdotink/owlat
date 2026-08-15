import type { Component, ComputedRef } from 'vue';
import type { Doc } from '@owlat/api/dataModel';

export type TriggerKind =
	| 'contact_created'
	| 'contact_updated'
	| 'event_received'
	| 'topic_subscribed';

export interface ContactUpdatedTriggerConfig {
	propertyKey: string;
}

export interface EventReceivedTriggerConfig {
	eventName: string;
}

export interface TopicSubscribedTriggerConfig {
	topicId: string;
}

export type TriggerConfigByKind = {
	contact_created: null;
	contact_updated: ContactUpdatedTriggerConfig;
	event_received: EventReceivedTriggerConfig;
	topic_subscribed: TopicSubscribedTriggerConfig;
};

export type TriggerConfigOfKind<K extends TriggerKind> = TriggerConfigByKind[K];

export interface TriggerEditorContext {
	readonly contactProperties: ComputedRef<Doc<'contactProperties'>[]>;
	readonly topics: ComputedRef<Doc<'topics'>[]>;
}

export interface TriggerDisplayContext {
	readonly topics: ComputedRef<Doc<'topics'>[]>;
}

/**
 * Registry-owned copy carries message KEYS, never sentences: these modules are
 * module-scope definitions, so they cannot call `useI18n`. A message that
 * interpolates values travels as its key plus those values; the component that
 * renders it is what translates (`t(value)` / `t(value.key, value.params)`).
 */
export type TriggerMessage = string | { key: string; params?: Record<string, unknown> };

export interface TriggerEditorModule<K extends TriggerKind> {
	readonly kind: K;
	/** A message key — see {@link TriggerMessage}. */
	readonly label: string;
	/** A message key — see {@link TriggerMessage}. */
	readonly description: string;
	readonly icon: string;
	readonly color: string;
	readonly requiresConfig: boolean;
	createDefault(): TriggerConfigOfKind<K>;
	validateForSubmit(config: TriggerConfigOfKind<K>): TriggerMessage | null;
	getSummary(config: TriggerConfigOfKind<K>, ctx: TriggerDisplayContext): TriggerMessage;
	readonly EditorComponent: Component | null;
}

export type TriggerEditorModuleMap = {
	[K in TriggerKind]: TriggerEditorModule<K>;
};
