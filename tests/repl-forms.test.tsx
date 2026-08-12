// Form and ListPicker are how every visual slash command collects input.
// A dropped key or a double-fired submit here runs the wrong command, or the
// right one twice — with a config write or an MCP server removal behind it.

import { describe, expect, it, vi } from 'vitest';

import { Form } from '../src/repl/forms/Form.tsx';
import { ListPicker } from '../src/repl/forms/ListPicker.tsx';
import type { FormField, ListItem } from '../src/repl/forms/types.ts';
import { type Harness, KEY, flush, press, renderInk } from './repl-harness.ts';

function pickerOf(
  items: ListItem[],
  handlers: { onPick?: (v: string) => void; onCancel?: () => void; emptyMessage?: string } = {},
): Harness {
  return renderInk(
    <ListPicker
      spec={{
        kind: 'list',
        title: 'Choose a provider',
        items,
        ...(handlers.emptyMessage !== undefined ? { emptyMessage: handlers.emptyMessage } : {}),
        onPick: () => null,
      }}
      onPick={handlers.onPick ?? (() => {})}
      onCancel={handlers.onCancel ?? (() => {})}
    />,
  );
}

const THREE: ListItem[] = [
  { value: 'ollama', label: 'Ollama' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI-compatible' },
];

describe('ListPicker', () => {
  it('shows the title and every item', async () => {
    const h = pickerOf(THREE);
    await flush();
    const frame = h.lastFrame();
    expect(frame).toContain('Choose a provider');
    for (const item of THREE) expect(frame).toContain(item.label);
    h.unmount();
  });

  it('starts on the first item', async () => {
    const onPick = vi.fn();
    const h = pickerOf(THREE, { onPick });
    await press(h, KEY.enter);
    expect(onPick).toHaveBeenCalledWith('ollama');
    h.unmount();
  });

  it('walks down and picks the highlighted value', async () => {
    const onPick = vi.fn();
    const h = pickerOf(THREE, { onPick });
    await press(h, KEY.down);
    await press(h, KEY.down);
    await press(h, KEY.enter);
    expect(onPick).toHaveBeenCalledWith('openai');
    h.unmount();
  });

  it('wraps around in both directions', async () => {
    const onPick = vi.fn();
    const h = pickerOf(THREE, { onPick });
    await press(h, KEY.up);
    await press(h, KEY.enter);
    expect(onPick).toHaveBeenCalledWith('openai');
    h.unmount();

    const onPick2 = vi.fn();
    const h2 = pickerOf(THREE, { onPick: onPick2 });
    for (let i = 0; i < 3; i++) await press(h2, KEY.down);
    await press(h2, KEY.enter);
    expect(onPick2).toHaveBeenCalledWith('ollama');
    h2.unmount();
  });

  it('cancels on Esc without picking anything', async () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    const h = pickerOf(THREE, { onPick, onCancel });
    await press(h, KEY.escape);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    h.unmount();
  });

  it('picks only once however fast Enter is pressed', async () => {
    // The pick usually starts an async command. A second dispatch would run
    // it twice — /mcp remove, /forget and friends are not idempotent.
    const onPick = vi.fn();
    const h = pickerOf(THREE, { onPick });
    await press(h, KEY.enter);
    await press(h, KEY.enter);
    await press(h, KEY.enter);
    expect(onPick).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it('ignores Esc once a pick is running', async () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    const h = pickerOf(THREE, { onPick, onCancel });
    await press(h, KEY.enter);
    await press(h, KEY.escape);
    expect(onCancel).not.toHaveBeenCalled();
    h.unmount();
  });

  it('says so when there is nothing to pick', async () => {
    const h = pickerOf([]);
    await flush();
    expect(h.lastFrame()).toContain('(no items)');
    h.unmount();
  });

  it('uses a caller-supplied empty message', async () => {
    const h = pickerOf([], { emptyMessage: 'no MCP servers configured' });
    await flush();
    expect(h.lastFrame()).toContain('no MCP servers configured');
    h.unmount();
  });

  it('does nothing on Enter with an empty list', async () => {
    const onPick = vi.fn();
    const h = pickerOf([], { onPick });
    await press(h, KEY.enter);
    await press(h, KEY.down);
    expect(onPick).not.toHaveBeenCalled();
    h.unmount();
  });

  it('still cancels from an empty list', async () => {
    const onCancel = vi.fn();
    const h = pickerOf([], { onCancel });
    await press(h, KEY.escape);
    expect(onCancel).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it('renders badges and descriptions', async () => {
    const h = pickerOf([
      { value: 'a', label: 'Alpha', badge: 'current', description: 'the default one' },
    ]);
    await flush();
    expect(h.lastFrame()).toContain('current');
    expect(h.lastFrame()).toContain('the default one');
    h.unmount();
  });

  it('shows a running state after a pick', async () => {
    const h = pickerOf(THREE, { onPick: () => {} });
    await press(h, KEY.enter);
    expect(h.lastFrame()).toContain('running');
    h.unmount();
  });
});

function formOf(
  fields: FormField[],
  handlers: {
    onSubmit?: (values: Record<string, string>) => void;
    onCancel?: () => void;
  } = {},
): Harness {
  return renderInk(
    <Form
      spec={{ kind: 'form', title: 'Configure', fields, onSubmit: () => null }}
      onSubmit={handlers.onSubmit ?? (() => {})}
      onCancel={handlers.onCancel ?? (() => {})}
    />,
  );
}

describe('Form — text fields', () => {
  it('submits what was typed', async () => {
    const onSubmit = vi.fn();
    const h = formOf([{ kind: 'text', key: 'model', label: 'Model' }], { onSubmit });
    await press(h, 'qwen3');
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ model: 'qwen3' });
    h.unmount();
  });

  it('starts from the default value', async () => {
    const onSubmit = vi.fn();
    const h = formOf(
      [{ kind: 'text', key: 'url', label: 'URL', defaultValue: 'http://localhost' }],
      {
        onSubmit,
      },
    );
    await flush();
    expect(h.lastFrame()).toContain('http://localhost');
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ url: 'http://localhost' });
    h.unmount();
  });

  it('refuses to submit while a required field is empty', async () => {
    const onSubmit = vi.fn();
    const h = formOf([{ kind: 'text', key: 'name', label: 'Name', required: true }], { onSubmit });
    await press(h, KEY.enter);
    expect(onSubmit).not.toHaveBeenCalled();
    h.unmount();
  });

  it('submits once the required field is filled', async () => {
    const onSubmit = vi.fn();
    const h = formOf([{ kind: 'text', key: 'name', label: 'Name', required: true }], { onSubmit });
    await press(h, KEY.enter);
    await press(h, 'asterisk');
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ name: 'asterisk' });
    h.unmount();
  });

  it('treats whitespace as empty for required fields', async () => {
    const onSubmit = vi.fn();
    const h = formOf([{ kind: 'text', key: 'name', label: 'Name', required: true }], { onSubmit });
    await press(h, '   ');
    await press(h, KEY.enter);
    expect(onSubmit).not.toHaveBeenCalled();
    h.unmount();
  });

  it('advances rather than submitting on a non-final field', async () => {
    const onSubmit = vi.fn();
    const h = formOf(
      [
        { kind: 'text', key: 'a', label: 'First' },
        { kind: 'text', key: 'b', label: 'Second' },
      ],
      { onSubmit },
    );
    await press(h, 'one');
    await press(h, KEY.enter);
    expect(onSubmit).not.toHaveBeenCalled();
    await press(h, 'two');
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ a: 'one', b: 'two' });
    h.unmount();
  });

  it('moves between fields with Tab and Shift+Tab', async () => {
    const onSubmit = vi.fn();
    const h = formOf(
      [
        { kind: 'text', key: 'a', label: 'First' },
        { kind: 'text', key: 'b', label: 'Second' },
      ],
      { onSubmit },
    );
    await press(h, 'one');
    await press(h, KEY.tab);
    await press(h, 'two');
    await press(h, KEY.shiftTab);
    await press(h, '!');
    await press(h, KEY.tab);
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ a: 'one!', b: 'two' });
    h.unmount();
  });

  it('submits from any field with Ctrl+S', async () => {
    const onSubmit = vi.fn();
    const h = formOf(
      [
        { kind: 'text', key: 'a', label: 'First' },
        { kind: 'text', key: 'b', label: 'Second' },
      ],
      { onSubmit },
    );
    await press(h, 'value');
    await press(h, KEY.ctrlS);
    expect(onSubmit).toHaveBeenCalledWith({ a: 'value', b: '' });
    h.unmount();
  });

  it('cancels on Esc without submitting', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const h = formOf([{ kind: 'text', key: 'a', label: 'First' }], { onSubmit, onCancel });
    await press(h, KEY.escape);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    h.unmount();
  });

  it('submits only once', async () => {
    const onSubmit = vi.fn();
    const h = formOf([{ kind: 'text', key: 'a', label: 'First' }], { onSubmit });
    await press(h, 'x');
    await press(h, KEY.enter);
    await press(h, KEY.enter);
    await press(h, KEY.ctrlS);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it('never shows a secret in clear text', async () => {
    const h = formOf([{ kind: 'text', key: 'key', label: 'API key', secret: true }]);
    await press(h, 'sk-super-secret');
    expect(h.lastFrame()).not.toContain('sk-super-secret');
    expect(h.lastFrame()).toContain('•');
    h.unmount();
  });

  it('still submits the real secret value', async () => {
    const onSubmit = vi.fn();
    const h = formOf([{ kind: 'text', key: 'key', label: 'API key', secret: true }], { onSubmit });
    await press(h, 'sk-123');
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ key: 'sk-123' });
    h.unmount();
  });

  it('shows a placeholder on an inactive empty field', async () => {
    const h = formOf([
      { kind: 'text', key: 'a', label: 'First' },
      { kind: 'text', key: 'b', label: 'Second', placeholder: 'optional note' },
    ]);
    await flush();
    expect(h.lastFrame()).toContain('optional note');
    h.unmount();
  });
});

describe('Form — select and confirm fields', () => {
  const select: FormField = {
    kind: 'select',
    key: 'mode',
    label: 'Mode',
    options: [
      { value: 'ask', label: 'Ask' },
      { value: 'allowlist', label: 'Allowlist' },
      { value: 'unrestricted', label: 'Unrestricted' },
    ],
  };

  it('defaults to the first option', async () => {
    const onSubmit = vi.fn();
    const h = formOf([select], { onSubmit });
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'ask' });
    h.unmount();
  });

  it('honours an explicit default', async () => {
    const onSubmit = vi.fn();
    const h = formOf([{ ...select, defaultValue: 'allowlist' }], { onSubmit });
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'allowlist' });
    h.unmount();
  });

  it('cycles right and wraps', async () => {
    const onSubmit = vi.fn();
    const h = formOf([select], { onSubmit });
    await press(h, KEY.right);
    await press(h, KEY.right);
    await press(h, KEY.right);
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'ask' });
    h.unmount();
  });

  it('cycles left from the first option to the last', async () => {
    const onSubmit = vi.fn();
    const h = formOf([select], { onSubmit });
    await press(h, KEY.left);
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'unrestricted' });
    h.unmount();
  });

  it('lists long option sets vertically so every choice is visible', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      value: `m${i}`,
      label: `model-${i}`,
      description: `description ${i}`,
    }));
    const h = formOf([{ kind: 'select', key: 'model', label: 'Model', options: many }]);
    await flush();
    for (const opt of many) expect(h.lastFrame()).toContain(opt.label);
    h.unmount();
  });

  it('defaults a confirm field to no', async () => {
    const onSubmit = vi.fn();
    const h = formOf([{ kind: 'confirm', key: 'sure', label: 'Delete it?' }], { onSubmit });
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ sure: 'no' });
    h.unmount();
  });

  it('flips a confirm field with the arrow keys', async () => {
    const onSubmit = vi.fn();
    const h = formOf([{ kind: 'confirm', key: 'sure', label: 'Delete it?' }], { onSubmit });
    await press(h, KEY.left);
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ sure: 'yes' });
    h.unmount();
  });

  it('honours a yes default', async () => {
    const onSubmit = vi.fn();
    const h = formOf([{ kind: 'confirm', key: 'sure', label: 'Proceed?', defaultValue: 'yes' }], {
      onSubmit,
    });
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ sure: 'yes' });
    h.unmount();
  });

  it('collects a mixed form in one submit', async () => {
    const onSubmit = vi.fn();
    const h = formOf(
      [
        { kind: 'text', key: 'name', label: 'Name' },
        select,
        { kind: 'confirm', key: 'sure', label: 'Sure?' },
      ],
      { onSubmit },
    );
    await press(h, 'server-one');
    await press(h, KEY.tab);
    await press(h, KEY.right);
    await press(h, KEY.tab);
    await press(h, KEY.left);
    await press(h, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'server-one',
      mode: 'allowlist',
      sure: 'yes',
    });
    h.unmount();
  });
});
