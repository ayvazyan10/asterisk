const CONCURRENCY_SAFE = new Set([
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  'BrowserSnapshot', 'BrowserScreenshot',
  'TaskList', 'TaskGet',
  'CodeIntel', 'DiffReview', 'McpListResources', 'McpReadResource',
]);

export function isConcurrencySafe(toolName: string): boolean {
  return CONCURRENCY_SAFE.has(toolName);
}
