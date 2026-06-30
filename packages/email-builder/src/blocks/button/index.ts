import { MousePointerClick } from '@lucide/vue';
import { moduleFor } from '@owlat/email-renderer';
import type { EditorModule } from '../_module';
import type { ButtonBlockContent } from '../../types';
import { buttonSchema } from '../../schema/definitions/button';
import { defaultPadding, defaultMargin } from '../../defaults';
import { computeButtonTextColor } from '../../utils/colors';

export const buttonEditor: EditorModule<'button'> = {
	type: 'button',
	label: 'Button',
	icon: MousePointerClick,
	schema: buttonSchema,
	slashCommand: {
		name: 'Button',
		description: 'Call-to-action button',
		category: 'components',
		aliases: ['btn', 'cta', 'link'],
	},
	canBeInColumn: true,
	canBeInContainer: true,
	supportsBorderRadius: true,
	// Renderer's button.createDefault hands back a flat '#ffffff' textColor;
	// the builder swaps in a luminance-aware choice against the theme's
	// primary color so the button stays readable on warm/cool brand colors.
	createDefault: (theme) =>
		({
			...moduleFor('button')!.createDefault!(theme),
			textColor: computeButtonTextColor(theme.primaryColor!),
			...defaultPadding,
			...defaultMargin,
		}) as ButtonBlockContent,
	createDefaultColumnItem: (theme) =>
		({
			text: 'Click here',
			url: 'https://',
			backgroundColor: theme.primaryColor!,
			textColor: computeButtonTextColor(theme.primaryColor!),
			align: 'center',
			borderRadius: 8,
			paddingX: 16,
			paddingY: 8,
			marginTop: 0,
			marginBottom: 0,
		}) as ButtonBlockContent,
};
