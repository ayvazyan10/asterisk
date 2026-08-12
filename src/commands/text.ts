// Small string helpers shared between command modules.
//
// They live here rather than in registry.ts so a command module can use them
// without importing the registry back — registry.ts imports the commands, and
// a value-level import in the other direction would close the cycle.

/** Clips long output, marking that it was clipped. */
export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}

/** Single-quotes a value for safe interpolation into a shell command. */
export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Joins pre-quoted arguments into a command line. */
export function shellJoin(args: string[]): string {
  return args.map(quote).join(' ');
}

/** Escapes a literal for use inside a regular expression. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
