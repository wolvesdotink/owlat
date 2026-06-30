import type { Component, ComputedRef } from 'vue';
import type { Doc } from '@owlat/api/dataModel';

export type TriggerKind = 'contact_created' | 'contact_updated' | 'event_received' | 'topic_subscribed';

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

export interface TriggerEditorModule<K extends TriggerKind> {
	readonly kind: K;
	readonly label: string;
	readonly description: string;
	readonly icon: string;
	readonly color: string;
	readonly requiresConfig: boolean;
	createDefault(): TriggerConfigOfKind<K>;
	validateForSubmit(config: TriggerConfigOfKind<K>): string | null;
	getSummary(config: TriggerConfigOfKind<K>, ctx: TriggerDisplayContext): string;
	readonly EditorComponent: Component | null;
}

export type TriggerEditorModuleMap = {
	[K in TriggerKind]: TriggerEditorModule<K>;
};
