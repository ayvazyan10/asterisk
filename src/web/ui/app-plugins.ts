// The Plugins page.
//
// It was two fields inside a collapsed Settings group — a checkbox called
// "Enabled" and a comma-separated list of paths — which is the wrong shape for
// the one surface in Asterisk that runs arbitrary code inside the agent's own
// process. Nothing about that group said what turning it on means, and the
// list gave no way to tell a path that resolves from one that does not.
//
// So the page leads with the position rather than the toggle: what a plugin
// gets when you load it, and what to use instead when you did not write the
// code. Then the switch, then one row per configured path carrying what can be
// known without importing anything — resolves, exists, is importable, listed
// twice.
//
// What is *loaded* is not on this page, and the API says so in a field rather
// than leaving the reader to infer it. The panel is not the process that loads
// plugins; the daemon and the REPL are. See ./api/plugins.ts.

export const APP_PLUGINS = String.raw`
// --- plugins --------------------------------------------------------------

/** What is wrong with an entry, or '' when it is fine. */
function pluginFault(e) {
  if (!e.absolute) return 'not an absolute path — the loader refuses it';
  if (!e.exists) return 'no file there';
  if (!e.importable) return 'not a module the loader can import';
  if (e.duplicate) return 'listed earlier too — it loads once';
  return '';
}

function pluginBadge(e) {
  const fault = pluginFault(e);
  if (fault) return ui.badge(e.duplicate && e.exists ? 'duplicate' : 'unusable', 'destructive', true);
  return ui.badge('resolves', 'success', true);
}

function pluginRow(e) {
  const fault = pluginFault(e);
  const detail = fault
    ? e.resolved + '  ·  ' + fault
    : e.resolved + '  ·  ' + bytes(e.bytes) + '  ·  changed ' + when(e.modified);

  return ui.listRow(
    '<code class="plugin-path">' + esc(e.path) + '</code> ' + pluginBadge(e),
    detail,
    ui.btn('Remove', { size: 'sm', variant: 'destructive-ghost',
      attrs: ' data-plugin-remove="' + esc(e.path) + '"' })
  );
}

function viewPlugins() {
  const d = state.plugins;
  const header = ui.pageHeader('Plugins',
    'TypeScript modules imported into the agent’s own process. A plugin can register tools and ' +
    'intercept every tool call, and it runs with everything Asterisk has — the store holding your ' +
    'keys, the tool registry, the permission gate itself.');

  if (!d) return header + '<section class="card">' + ui.skeletonRows(3) + '</section>';

  // The one thing a reader has to understand before the switch, not after it.
  const position = ui.card('Before you turn this on',
    '<div class="card-content prose">' +
      '<p>The sandbox does not help here. It confines child <em>processes</em>, and a plugin is a ' +
      'function call — so there is nothing between a plugin and your secrets.</p>' +
      '<p>The rule that follows: code you wrote or read becomes a plugin; code you did not becomes ' +
      'an <a class="link" href="#mcp">MCP server</a>, where the isolation is that it is a separate ' +
      'process. There is no directory scan either — a file has to be named here to be loaded, so ' +
      'dropping one into a folder is never enough.</p>' +
    '</div>');

  const toggle = ui.card('Loading', ui.listRow(
    'Load the plugins listed below ' + ui.stateBadge(d.enabled, 'on', 'off'),
    d.enabled
      ? 'Every entry that resolves is imported when the daemon or the REPL starts.'
      : 'Nothing below is imported. Entries are kept, so turning this on loads them.',
    '<span class="switch-cell">' +
      '<button class="switch" role="switch" data-action="plugin-toggle" aria-checked="' +
        d.enabled + '" aria-label="Load plugins"></button>' +
    '</span>'
  ));

  const rows = d.entries.length === 0
    ? ui.empty('No plugins configured.')
    : d.entries.map(pluginRow).join('');

  const usable = d.entries.filter((e) => !pluginFault(e)).length;

  const form = '<div class="form-grid">' +
    '<label class="label" for="plugin-path">Module path</label>' +
    '<input class="input" type="text" id="plugin-path" placeholder="~/.asterisk/plugins/my-plugin.ts">' +
    '<div class="form-span section-actions">' +
      ui.btn('Add plugin', { variant: 'default', attrs: ' data-action="plugin-add"' }) +
      '<span class="form-hint">Must default-export { name, register }. Order matters: tools ' +
        'registered later shadow earlier ones of the same name.</span>' +
    '</div></div>';

  // Said once, plainly, instead of showing a "loaded" column this process
  // cannot fill in.
  const runtime = '<p class="form-hint mt">This page reads the configuration. What is actually ' +
    'loaded right now is known only to the process running the agent — ask it with ' +
    '<code class="code-inline">/plugins</code> in the REPL, or read the startup lines in the ' +
    '<a class="link" href="#logs">daemon log</a>.</p>';

  return header + position + toggle +
    addPanel('plugin-add-panel', 'Add a plugin', form) +
    ui.card('Configured', rows, {
      aside: ui.badge(usable + ' of ' + d.entries.length + ' resolve',
        usable === d.entries.length ? 'secondary' : 'destructive'),
    }) +
    runtime;
}

async function loadPlugins() {
  state.plugins = await guard(() => api('/plugins'));
}

/** Writes the list through the ordinary settings PATCH — the only write path. */
async function savePluginPaths(paths) {
  const ok = await guard(() => api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ updates: { 'plugins.load': paths } }),
  }), 'Plugin list saved');
  if (!ok) return;
  await loadPlugins();
  render();
}

async function togglePlugins() {
  const next = !(state.plugins && state.plugins.enabled);
  const ok = await guard(() => api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ updates: { 'plugins.enabled': next } }),
  }), next ? 'Plugins will load on next start' : 'Plugins turned off');
  if (!ok) return;
  await loadPlugins();
  render();
}

async function addPlugin() {
  const path = $('#plugin-path').value.trim();
  if (!path) { toast('A module path is required', 'bad'); return; }
  const existing = state.plugins ? state.plugins.entries.map((e) => e.path) : [];
  if (existing.includes(path)) { toast('That path is already listed', 'bad'); return; }
  await savePluginPaths([...existing, path]);
}

async function removePlugin(path) {
  const existing = state.plugins ? state.plugins.entries.map((e) => e.path) : [];
  await savePluginPaths(existing.filter((p) => p !== path));
}
`;
