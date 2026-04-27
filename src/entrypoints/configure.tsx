// Entrypoint for `asterisk configure`. Mounts the Ink wizard.

import { render } from 'ink';
import React from 'react';
import { ConfigureWizard } from '../config/wizard.tsx';

render(<ConfigureWizard />);
