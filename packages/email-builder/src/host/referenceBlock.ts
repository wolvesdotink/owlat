/**
 * Reference bundled email block: a "callout" admonition box.
 *
 * This is the worked example of a plugin-contributed block that ships with the
 * platform. It exists to be exercised end to end across BOTH halves of the
 * block vertical:
 * - the renderer half (a `BlockRenderer`) turns the block into email-safe HTML;
 * - the editor half (a `BlockDefinition`) gives it a label, slash command,
 *   default factory and capability flags in the builder.
 *
 * It is composed through `composeHostedEmailBlocks`, exactly like any other
 * plugin block, and demonstrates the required author discipline: block content
 * is treated as untrusted and escaped before it reaches the HTML.
 */

import { Info } from '@lucide/vue';
import { escapeHtml, type BlockRenderer } from '@owlat/email-renderer';
import { parsePluginId, type PluginId } from '@owlat/plugin-kit';
import type { BlockDefinition } from '../registry/blockRegistry';
import { defaultPadding, defaultMargin } from '../defaults';
import type { HostedEmailBlockContribution } from './emailBlockHost';

/** Block type tag for the reference callout block. */
export const REFERENCE_CALLOUT_TYPE = 'reference-callout';

/** The plugin identity that owns the reference bundled block. */
export const referenceEmailBlockPluginId: PluginId = parsePluginId('owlat-reference');

/** Content shape of the reference callout block. */
export interface CalloutBlockContent {
	title: string;
	body: string;
}

/**
 * Renderer half. Emits a single-cell bordered table — the portable way to draw
 * a boxed callout across email clients. `title` and `body` are author-supplied
 * and therefore HTML-escaped before interpolation.
 */
const renderCallout: BlockRenderer = (content) => {
	const c = content as Partial<CalloutBlockContent>;
	const title = escapeHtml(c.title ?? '');
	const body = escapeHtml(c.body ?? '');
	const titleHtml = title ? `<div style="font-weight:700;margin-bottom:4px">${title}</div>` : '';
	return (
		`<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">` +
		`<tr><td style="border-left:4px solid #2563eb;background-color:#eff6ff;padding:12px 16px;border-radius:4px">` +
		`${titleHtml}<div>${body}</div>` +
		`</td></tr></table>`
	);
};

/** Editor half: label, slash command, defaults and capability flags. */
const calloutEditor: BlockDefinition = {
	type: REFERENCE_CALLOUT_TYPE as BlockDefinition['type'],
	label: 'Callout',
	createDefault: () =>
		({
			title: 'Heads up',
			body: 'Use a callout to draw attention to important context.',
			...defaultPadding,
			...defaultMargin,
		}) as unknown as ReturnType<BlockDefinition['createDefault']>,
	slashCommand: {
		name: 'Callout',
		description: 'Highlighted admonition box',
		icon: Info,
		category: 'components',
		aliases: ['note', 'admonition', 'info'],
	},
	canBeInColumn: false,
	canBeInContainer: false,
	supportsBorderRadius: true,
	focusOnInsert: false,
};

/**
 * The reference block as a hosted contribution — the exact shape a real plugin
 * would hand the host, with both halves paired under one plugin id.
 */
export const referenceEmailBlockContribution: HostedEmailBlockContribution = {
	pluginId: referenceEmailBlockPluginId,
	renderers: [{ type: REFERENCE_CALLOUT_TYPE, render: renderCallout }],
	editors: [{ type: REFERENCE_CALLOUT_TYPE, definition: calloutEditor }],
};
