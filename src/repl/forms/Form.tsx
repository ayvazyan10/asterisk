// Form modal — multi-field input widget. Each field is one of text, select,
// or confirm. Tab / ↓ moves to the next field, Shift+Tab / ↑ to the previous,
// ← / → cycles options on select fields, Enter on the last field submits,
// Esc cancels.

import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useMemo, useState } from 'react';

import type { FormField, FormSpec, SelectField } from './types.ts';

interface Props {
  spec: FormSpec;
  onSubmit(values: Record<string, string>): Promise<void> | void;
  onCancel(): Promise<void> | void;
}

export function Form({ spec, onSubmit, onCancel }: Props) {
  const [active, setActive] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const initial = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of spec.fields) out[f.key] = defaultFor(f);
    return out;
  }, [spec.fields]);
  const [values, setValues] = useState<Record<string, string>>(initial);

  const setVal = (key: string, value: string) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const isLast = active === spec.fields.length - 1;

  async function tryCancel() {
    if (submitting) return;
    setSubmitting(true);
    await onCancel();
  }

  async function trySubmit() {
    if (submitting) return;
    // Validate required text fields.
    for (const f of spec.fields) {
      if (f.kind === 'text' && f.required && (values[f.key] ?? '').trim() === '') {
        // Jump to the missing field.
        const missing = spec.fields.findIndex((g) => g.key === f.key);
        if (missing !== -1) setActive(missing);
        return;
      }
    }
    setSubmitting(true);
    await onSubmit(values);
  }

  // Global keys (Tab, Shift+Tab, ↑, ↓, Esc, Ctrl+S). The active field's local
  // input handles its own keys (text typing, ←/→ for selects).
  useInput((input, key) => {
    if (submitting) return;
    if (key.escape) {
      void tryCancel();
      return;
    }
    if (key.ctrl && input === 's') {
      void trySubmit();
      return;
    }
    // Tab / Shift-Tab move between fields.
    if (key.tab && key.shift) {
      setActive((i) => (i - 1 + spec.fields.length) % spec.fields.length);
      return;
    }
    if (key.tab) {
      setActive((i) => (i + 1) % spec.fields.length);
      return;
    }
    // ↑/↓ also move between fields, except on text fields where TextInput
    // already ignores them so they're available.
    if (key.upArrow) {
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setActive((i) => Math.min(spec.fields.length - 1, i + 1));
    }
  });

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={0} flexDirection="column">
      <Box>
        <Text color="cyan" bold>
          {spec.title}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {spec.fields.map((field, idx) => {
          const isActive = idx === active && !submitting;
          return (
            <FieldRow
              key={field.key}
              field={field}
              value={values[field.key] ?? ''}
              setValue={(v) => setVal(field.key, v)}
              active={isActive}
              isLast={isLast && isActive}
              onSubmitField={() => {
                if (idx < spec.fields.length - 1) setActive(idx + 1);
                else void trySubmit();
              }}
            />
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {submitting
            ? '  …submitting…'
            : `  Tab next · Shift+Tab back · Enter on last field submits · Ctrl+S submit · Esc cancel`}
        </Text>
      </Box>
    </Box>
  );
}

function defaultFor(f: FormField): string {
  if (f.kind === 'text') return f.defaultValue ?? '';
  if (f.kind === 'select') return f.defaultValue ?? f.options[0]?.value ?? '';
  return f.defaultValue ?? 'no';
}

interface RowProps {
  field: FormField;
  value: string;
  setValue(v: string): void;
  active: boolean;
  isLast: boolean;
  onSubmitField(): void;
}

function FieldRow({ field, value, setValue, active, isLast, onSubmitField }: RowProps) {
  const arrow = active ? '› ' : '  ';
  const label = `${arrow}${field.label}`;
  const labelColor = active ? 'cyan' : undefined;

  if (field.kind === 'text') {
    const display = field.secret && value ? '•'.repeat(Math.min(value.length, 16)) : value;
    return (
      <Box flexDirection="column">
        <Box>
          {labelColor ? (
            <Text color={labelColor} bold={active}>
              {label}
            </Text>
          ) : (
            <Text>{label}</Text>
          )}
        </Box>
        <Box marginLeft={4}>
          {active ? (
            field.secret ? (
              <SecretInput value={value} onChange={setValue} onSubmit={onSubmitField} />
            ) : (
              <TextInput
                value={value}
                onChange={setValue}
                onSubmit={onSubmitField}
                placeholder={field.placeholder ?? ''}
              />
            )
          ) : (
            <Text dimColor>{display || field.placeholder || '(empty)'}</Text>
          )}
        </Box>
      </Box>
    );
  }

  if (field.kind === 'select') {
    return (
      <Box flexDirection="column">
        <Box>
          {labelColor ? (
            <Text color={labelColor} bold={active}>
              {label}
            </Text>
          ) : (
            <Text>{label}</Text>
          )}
        </Box>
        <Box marginLeft={4}>
          <SelectRow
            field={field}
            value={value}
            onChange={setValue}
            active={active}
            onAdvance={onSubmitField}
            isLast={isLast}
          />
        </Box>
      </Box>
    );
  }

  // confirm
  return (
    <Box flexDirection="column">
      <Box>
        {labelColor ? (
          <Text color={labelColor} bold={active}>
            {label}
          </Text>
        ) : (
          <Text>{label}</Text>
        )}
      </Box>
      <Box marginLeft={4}>
        <SelectRow
          field={{
            kind: 'select',
            key: field.key,
            label: field.label,
            options: [
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ],
            defaultValue: field.defaultValue ?? 'no',
          }}
          value={value || (field.defaultValue ?? 'no')}
          onChange={setValue}
          active={active}
          onAdvance={onSubmitField}
          isLast={isLast}
        />
      </Box>
    </Box>
  );
}

interface SelectRowProps {
  field: SelectField;
  value: string;
  onChange(v: string): void;
  active: boolean;
  onAdvance(): void;
  isLast: boolean;
}

function SelectRow({ field, value, onChange, active, onAdvance, isLast }: SelectRowProps) {
  useInput(
    (_input, key) => {
      if (!active) return;
      const idx = Math.max(
        0,
        field.options.findIndex((o) => o.value === value),
      );
      if (key.leftArrow) {
        const next = field.options[(idx - 1 + field.options.length) % field.options.length];
        if (next) onChange(next.value);
        return;
      }
      if (key.rightArrow) {
        const next = field.options[(idx + 1) % field.options.length];
        if (next) onChange(next.value);
        return;
      }
      if (key.return) {
        if (isLast) onAdvance();
        else onAdvance();
      }
    },
    { isActive: active },
  );

  // For long option lists (e.g. all Anthropic models), render vertically so
  // the user sees every choice. Use ←/→ to cycle (already handled above).
  if (field.options.length > 4) {
    return (
      <Box flexDirection="column">
        {field.options.map((opt) => {
          const isSelected = opt.value === value;
          if (active && isSelected) {
            return (
              <Box key={opt.value}>
                <Text color="cyan" bold>
                  {'› ● '}
                  {opt.label}
                </Text>
                {opt.description && opt.description !== opt.label && (
                  <Text dimColor>{`  ${opt.description}`}</Text>
                )}
              </Box>
            );
          }
          if (isSelected) {
            return (
              <Box key={opt.value}>
                <Text>{'  ● ' + opt.label}</Text>
                {opt.description && opt.description !== opt.label && (
                  <Text dimColor>{`  ${opt.description}`}</Text>
                )}
              </Box>
            );
          }
          return (
            <Box key={opt.value}>
              <Text dimColor>{'  ○ ' + opt.label}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  return (
    <Box>
      {field.options.map((opt, i) => {
        const isSelected = opt.value === value;
        const marker = isSelected ? '●' : '○';
        const sep = i === 0 ? '' : '   ';
        if (active && isSelected) {
          return (
            <Text key={opt.value} color="cyan" bold>
              {sep}
              {marker} {opt.label}
            </Text>
          );
        }
        return (
          <Text key={opt.value}>
            {sep}
            {marker} {opt.label}
          </Text>
        );
      })}
    </Box>
  );
}

interface SecretInputProps {
  value: string;
  onChange(v: string): void;
  onSubmit(): void;
}

function SecretInput({ value, onChange, onSubmit }: SecretInputProps) {
  // ink-text-input doesn't support a mask; render a TextInput with the actual
  // value but display a masked version above it. The TextInput itself shows
  // the raw value at the cursor; for genuine secrecy we just hide the value
  // until the next field, which is good enough for our flow (the value is
  // immediately written to ~/.asterisk/secrets.env on submit).
  return <TextInput value={value} onChange={onChange} onSubmit={onSubmit} mask="•" />;
}
