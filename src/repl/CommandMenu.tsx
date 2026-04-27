// Visual command picker — appears under the input box when the user types `/`.
// Lists matching commands with descriptions, highlights the current selection,
// and shows the usage hint for the highlighted entry.

import { Box, Text } from 'ink';

import { COMMANDS, type SlashCommand } from '../commands/registry.ts';

export function filterCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  // Only filter on the command-name portion. Once the user types a space,
  // the entered command is locked and we just show its hint (if any).
  const space = input.indexOf(' ');
  const namePart = space === -1 ? input.slice(1) : input.slice(1, space);
  const lower = namePart.toLowerCase();
  if (space !== -1) {
    return COMMANDS.filter((c) => c.name.slice(1).toLowerCase() === lower);
  }
  return COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(lower));
}

export function clampSelection(input: string, selectedIndex: number): number {
  const matches = filterCommands(input);
  if (matches.length === 0) return 0;
  if (selectedIndex < 0) return 0;
  if (selectedIndex >= matches.length) return matches.length - 1;
  return selectedIndex;
}

interface Props {
  input: string;
  selectedIndex: number;
}

export function CommandMenu({ input, selectedIndex }: Props) {
  if (!input.startsWith('/')) return null;
  const matches = filterCommands(input);

  if (matches.length === 0) {
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>(no matching command — Esc to clear, /help to list all)</Text>
      </Box>
    );
  }

  const safeIndex = clampSelection(input, selectedIndex);
  const selected = matches[safeIndex];

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
      {matches.map((cmd, i) => {
        const active = i === safeIndex;
        return (
          <Box key={cmd.name}>
            {active ? (
              <Text color="cyan" bold>
                {'› '}
                {cmd.name.padEnd(12)}
              </Text>
            ) : (
              <Text>{'  ' + cmd.name.padEnd(12)}</Text>
            )}
            <Text dimColor> {cmd.description}</Text>
          </Box>
        );
      })}
      {selected?.usage && (
        <Box marginTop={1}>
          <Text dimColor>usage: {selected.usage}</Text>
        </Box>
      )}
      <Box>
        <Text dimColor>{'  ↑↓ navigate · Tab complete · Enter run · Esc clear'}</Text>
      </Box>
    </Box>
  );
}
