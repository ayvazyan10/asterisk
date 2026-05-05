const CONCURRENCY_SAFE = new Set([
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  'BrowserSnapshot', 'BrowserScreenshot',
  'TaskList', 'TaskGet',
]);

export function isConcurrencySafe(toolName: string): boolean {
  return CONCURRENCY_SAFE.has(toolName);
}
