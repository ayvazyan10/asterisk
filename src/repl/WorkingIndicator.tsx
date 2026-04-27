// Animated "working" indicator shown in the input area while the agent is
// busy. Spins at ~80ms, re-renders the elapsed counter every tick.

import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;

interface Props {
  since: number;
  status: string;
}

export function WorkingIndicator({ since, status }: Props) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), FRAME_MS);
    return () => clearInterval(id);
  }, []);

  const elapsedSec = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const elapsedLabel =
    elapsedSec < 60
      ? `${elapsedSec}s`
      : `${Math.floor(elapsedSec / 60)}m ${(elapsedSec % 60).toString().padStart(2, '0')}s`;

  return (
    <Box>
      <Text color="yellow" bold>
        {SPINNER_FRAMES[frame]}
      </Text>
      <Text color="yellow">{` ${status}`}</Text>
      <Text dimColor>{`  · ${elapsedLabel}`}</Text>
    </Box>
  );
}
