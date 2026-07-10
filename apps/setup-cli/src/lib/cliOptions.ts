/**
 * Options every `owlat` subcommand receives from the top-level dispatcher
 * (`src/index.ts`). Commands that need extra flags extend this interface.
 */
export interface CliOptions {
	web: boolean;
	terminal: boolean;
	assumeYes: boolean;
	owlatDir: string;
	configFile?: string;
	positional: string[];
	args: string[];
}
