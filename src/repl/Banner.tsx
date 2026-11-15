// Welcome banner for the REPL.
//
// The emblem, drawn in box characters: a vertical bar crossed by two
// diagonals that stop short of each other, so the centre stays open the way
// the real mark's arms stop short of theirs (see src/web/ui/logo.ts). Two
// rows tall so it sits beside the two lines of text rather than above them,
// and in the same starlight gold the panel uses for it.

import { Box, Text } from 'ink';

interface Props {
  providerName: string;
  cwd: string;
  version: string;
}

const STARLIGHT = '#f2c45a';
const MARK = ['╲ ┃ ╱', '╱ ┃ ╲'];

export function Banner({ providerName, cwd, version }: Props) {
  return (
    <Box marginBottom={1} paddingLeft={1}>
      <Box flexDirection="column" marginRight={2}>
        {MARK.map((row) => (
          <Text key={row} color={STARLIGHT} bold>
            {row}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text>
          <Text bold>Asterisk</Text>
          <Text dimColor>{` v${version}   ${providerName}   ${shortenPath(cwd)}`}</Text>
        </Text>
        <Text dimColor>/help for commands · Esc cancels a turn · /quit or ^C to exit</Text>
      </Box>
    </Box>
  );
}

function shortenPath(p: string): string {
  const home = process.env['HOME'] ?? '';
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}
