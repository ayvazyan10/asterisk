// Visual form / list-picker types. A SlashCommand can return one of these
// instead of a plain string, and the REPL will render the appropriate widget
// and gather input visually rather than expecting argument-line text.

export interface TextField {
  kind: 'text';
  key: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  // Hide while typing (passwords / API keys).
  secret?: boolean;
  // Free-form multi-word values like "node /path/to/server.js arg1 arg2".
  multiToken?: boolean;
}

export interface SelectField {
  kind: 'select';
  key: string;
  label: string;
  options: SelectOption[];
  defaultValue?: string;
}

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface ConfirmField {
  kind: 'confirm';
  key: string;
  label: string;
  defaultValue?: 'yes' | 'no';
}

export type FormField = TextField | SelectField | ConfirmField;

export interface FormSpec {
  kind: 'form';
  title: string;
  fields: FormField[];
  submitLabel?: string;
  onSubmit(values: Record<string, string>): Promise<CommandResult> | CommandResult;
  onCancel?(): Promise<CommandResult> | CommandResult;
}

export interface ListItem {
  value: string;
  label: string;
  description?: string;
  badge?: string;
}

export interface ListSpec {
  kind: 'list';
  title: string;
  items: ListItem[];
  emptyMessage?: string;
  onPick(value: string): Promise<CommandResult> | CommandResult;
  onCancel?(): Promise<CommandResult> | CommandResult;
}

// Plain string → printed as a system message in the transcript.
// null         → no transcript output (used by /clear, /quit).
// FormSpec     → render a form modal.
// ListSpec     → render a list-picker modal.
export type CommandResult = string | null | FormSpec | ListSpec;
