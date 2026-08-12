// List picker modal — select one item with arrow keys, Enter picks, Esc
// cancels. Supports an optional badge string to mark items (e.g. * current).

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import type { ListSpec } from './types.ts';

interface Props {
  spec: ListSpec;
  onPick(value: string): Promise<void> | void;
  onCancel(): Promise<void> | void;
}

export function ListPicker({ spec, onPick, onCancel }: Props) {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);

  const total = spec.items.length;

  useInput((_input, key) => {
    if (busy) return;
    if (key.escape) {
      setBusy(true);
      void Promise.resolve(onCancel());
      return;
    }
    if (total === 0) return;
    if (key.upArrow) {
      setIndex((i) => (i - 1 + total) % total);
      return;
    }
    if (key.downArrow) {
      setIndex((i) => (i + 1) % total);
      return;
    }
    if (key.return) {
      const target = spec.items[index];
      if (!target) return;
      setBusy(true);
      void Promise.resolve(onPick(target.value));
    }
  });

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={0} flexDirection="column">
      <Box>
        <Text color="cyan" bold>
          {spec.title}
        </Text>
      </Box>
      {total === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>{spec.emptyMessage ?? '(no items)'}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {spec.items.map((item, i) => {
            const active = i === index;
            return (
              <Box key={item.value}>
                {active ? (
                  <Text color="cyan" bold>
                    {'› '}
                    {item.label}
                  </Text>
                ) : (
                  <Text>{`  ${item.label}`}</Text>
                )}
                {item.badge && (
                  <Text color="green" dimColor>
                    {'  '}
                    {item.badge}
                  </Text>
                )}
                {item.description && <Text dimColor>{`  · ${item.description}`}</Text>}
              </Box>
            );
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>{busy ? '  …running…' : '  ↑↓ navigate · Enter pick · Esc cancel'}</Text>
      </Box>
    </Box>
  );
}
