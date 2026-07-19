/**
 * The output sink every command writes through. Production wires it to the
 * console; tests capture the lines and assert on them, so no command reaches
 * for `console.*` directly.
 */
export interface CliIo {
	log(message: string): void;
	error(message: string): void;
}
