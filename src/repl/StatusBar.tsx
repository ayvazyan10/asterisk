// Status footer line for the REPL.

import { Box, Text } from 'ink';

interface Props {
  providerName: string;
  historyCount: number;
  cwd: string;
  busy: boolean;
}

export function StatusBar({ providerName, historyCount, cwd, busy }: Props) {
  return (
    <Box>
      <Text dimColor>
        {' '}
        {busy ? '⏳ working' : '◌ ready'}
        {'  ·  '}
        {providerName}
        {'  ·  '}
        {historyCount} msgs
        {'  ·  '}
        {shortenPath(cwd)}
      </Text>
    </Box>
  );
}

function shortenPath(p: string): string {
  const home = process.env['HOME'] ?? '';
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}
