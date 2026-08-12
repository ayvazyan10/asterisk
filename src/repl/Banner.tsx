// Welcome banner for the REPL.

import { Box, Text } from 'ink';

interface Props {
  providerName: string;
  cwd: string;
  version: string;
}

export function Banner({ providerName, cwd, version }: Props) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={0} flexDirection="column">
        <Text>
          <Text color="cyan" bold>
            {' ✱ Asterisk '}
          </Text>
          <Text dimColor>v{version}</Text>
        </Text>
        <Text dimColor>{' /help for commands · /quit to exit · ^C to abort'}</Text>
      </Box>
      <Text dimColor>{`  ${providerName}  ·  ${shortenPath(cwd)}`}</Text>
    </Box>
  );
}

function shortenPath(p: string): string {
  const home = process.env['HOME'] ?? '';
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}
