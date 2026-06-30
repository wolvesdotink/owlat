import { ChartBar } from '@lucide/vue';
import type { EditorModule } from '../_module';
import { progressBarSchema } from '../../schema/definitions/progressBar';

export const progressBarEditor: EditorModule<'progressBar'> = {
	type: 'progressBar',
	label: 'Progress',
	icon: ChartBar,
	schema: progressBarSchema,
	slashCommand: {
		name: 'Progress Bar',
		description: 'Visual progress indicator',
		category: 'components',
		aliases: ['progress', 'bar', 'meter'],
	},
	canBeInColumn: false,
	canBeInContainer: false,
	supportsBorderRadius: true,
};
