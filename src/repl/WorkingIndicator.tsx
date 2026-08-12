// Animated "working" indicator shown in the input area while the agent is
// busy. Spinner glyph cycles every 80ms. The verb (one of ~30 gerunds) is
// picked once at mount and stays for the whole turn — same pattern claude-
// code-main uses for its "Crunched / Worked" UX so a long silent
// tool-call-generation phase doesn't look frozen.
//
// Status text comes from event hooks (setWorkingStatus). When no event has
// updated it in >SILENCE_THRESHOLD_MS we fall back to "<verb> · Xm Ys" so
// the user sees a self-updating phrase instead of a frozen "thinking".

import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;
// After this many ms without a status update, the indicator falls back to
// the cycled verb. Empirically, after ~5 seconds of silence a static
// "thinking" label feels frozen even if the spinner is still spinning.
const SILENCE_THRESHOLD_MS = 5_000;

const VERBS = [
  'Pondering',
  'Crunching',
  'Calculating',
  'Cogitating',
  'Computing',
  'Reasoning',
  'Brewing',
  'Cooking',
  'Working',
  'Thinking',
  'Considering',
  'Mulling',
  'Weighing',
  'Reflecting',
  'Plotting',
  'Synthesising',
  'Composing',
  'Drafting',
  'Sketching',
  'Mapping',
  'Charting',
  'Forging',
  'Spinning',
  'Sifting',
  'Distilling',
  'Tinkering',
  'Pacing',
  'Searching',
  'Tracing',
  'Pursuing',
];

interface Props {
  since: number;
  status: string;
}

export function WorkingIndicator({ since, status }: Props) {
  const [frame, setFrame] = useState(0);
  // Tick every 250ms so the silence-fallback status updates without waiting
  // on a setState elsewhere.
  const [, setTick] = useState(0);
  // Track when the externally-supplied status was last set so we can fall
  // back to the cycled verb during long silences.
  const [statusStamp, setStatusStamp] = useState({ value: status, at: Date.now() });

  // One verb per turn, derived from the turn's start timestamp rather than
  // drawn at random. `since` changes exactly when a new turn begins, so the
  // verb still varies turn to turn — but it is now a genuine function of its
  // dependency, which means the memo is honest about what it depends on and
  // the component renders deterministically for a given turn (also making it
  // testable, which the random version was not).
  const verb = useMemo(
    () => VERBS[Math.abs(Math.trunc(since / 1000)) % VERBS.length] ?? 'Working',
    [since],
  );

  // The timestamp lives next to the value it describes, so the effect reads
  // `status` rather than merely being keyed on it — which is both honest about
  // the dependency and cheaper, since an identical status no longer restarts
  // the silence timer.
  useEffect(() => {
    setStatusStamp((prev) => (prev.value === status ? prev : { value: status, at: Date.now() }));
  }, [status]);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), FRAME_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, []);

  const elapsedSec = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const elapsedLabel =
    elapsedSec < 60
      ? `${elapsedSec}s`
      : `${Math.floor(elapsedSec / 60)}m ${(elapsedSec % 60).toString().padStart(2, '0')}s`;
  const silenceMs = Date.now() - statusStamp.at;
  const displayStatus = silenceMs > SILENCE_THRESHOLD_MS ? `${verb}…` : status;

  return (
    <Box>
      <Text color="yellow" bold>
        {SPINNER_FRAMES[frame]}
      </Text>
      <Text color="yellow">{` ${displayStatus}`}</Text>
      <Text dimColor>{`  · ${elapsedLabel}  · ESC to cancel`}</Text>
    </Box>
  );
}
