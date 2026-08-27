// The Skills section.
//
// Every other content kind is a file tree with a textarea over it, and that is
// the right shape for rules, agents and souls. Skills earn their own view
// because they are not files to the agent: they resolve from three scopes that
// override each other by name, they carry frontmatter that either validates or
// does not, and the 29 bundled ones have no file at all. The old view could
// show none of that, and its "new file" form created skills/<x>.md — which the
// loader refuses outright.
//
// So this is /skills validate with somewhere to click. Backed by
// ../api/skills.ts; concatenated after APP_STAR and before APP_VIEWS.

export const APP_SKILLS = String.raw`
const SCOPE_BADGE = { bundled: 'muted', user: 'secondary', project: 'outline' };

const SCOPE_NOTE = {
  bundled: 'Built into Asterisk. Copy it into a skill of your own to change it.',
  project: 'Lives with this project, outside your Asterisk home — edit it there.',
};

async function loadSkills() {
  state.skills = await guard(() => api('/skills'));
}

async function openSkill(name) {
  const body = await guard(() => api('/skills/' + encodeURIComponent(name)));
  if (!body) return;
  state.skill = body;
  state.skillDraft = { description: body.description, prompt: body.prompt };
  render();
}

function skillDirty() {
  const s = state.skill;
  const d = state.skillDraft;
  if (!s || !d) return false;
  return d.description !== s.description || d.prompt !== s.prompt;
}

async function saveSkill() {
  const s = state.skill;
  if (!s || !s.editable) return;
  const ok = await guard(() => api('/skills/' + encodeURIComponent(s.name), {
    method: 'PUT',
    body: JSON.stringify(state.skillDraft),
  }), 'Saved ' + s.name);
  if (!ok) return;
  await loadSkills();
  await openSkill(s.name);
}

async function deleteSkillEntry() {
  const s = state.skill;
  if (!s || !s.editable) return;
  if (!confirm('Delete the skill "' + s.name + '"? Its whole directory goes.')) return;
  const ok = await guard(() => api('/skills/' + encodeURIComponent(s.name), { method: 'DELETE' }),
    'Deleted ' + s.name);
  if (!ok) return;
  state.skill = null;
  state.skillDraft = null;
  await loadSkills();
  render();
}

/** Sets/clears the message beside one of the New skill form's two required
 * fields, and aria-invalid with it — the same shape as Settings'
 * showFieldError/clearFieldError in app-settings.ts, sized down for a form
 * with two fixed fields rather than a generated one. */
function setSkillFormError(field, message) {
  const input = $('#skill-' + field);
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  const node = $('#skill-' + field + '-error');
  if (node) node.textContent = message || '';
}

async function createSkill() {
  const name = $('#skill-name').value.trim();
  const description = $('#skill-description').value.trim();

  setSkillFormError('name', name ? '' : 'A name is required.');
  setSkillFormError('description', description ? '' : 'A description is required.');
  if (!name || !description) {
    toast('A name and a description are both required', 'bad');
    // Focus the first offending field rather than leaving it on the Create
    // button — same reasoning as Settings' applySettings() in app-settings.ts.
    $('#skill-' + (name ? 'description' : 'name')).focus();
    return;
  }

  const ok = await guard(() => api('/skills/' + encodeURIComponent(name), {
    method: 'PUT',
    body: JSON.stringify({
      description,
      prompt: 'Describe what this skill should do, step by step.',
    }),
  }), 'Created ' + name);
  if (!ok) return;
  await loadSkills();
  await openSkill(name);
}

// --- rendering -----------------------------------------------------------

/**
 * Loader messages are written for a terminal, where the path prints on its own
 * line above them — so several of them quote an absolute path inline. Against
 * the root already shown in the page title those are pure noise, and printing
 * the issue's own path beside such a message showed the same directory twice.
 */
function relativeTo(text, root) {
  return String(text).split(root + '/').join('');
}

// A row in the Problems list — role="listitem" directly on it (a bare <div>
// has no implicit role of its own to clash with), paired with ui.list()
// wrapping the concatenated rows in skillIssuesCard below.
function skillIssueRow(issue, root) {
  const error = issue.severity === 'error';
  return '<div class="list-row" role="listitem">' +
    ui.badge(error ? 'not loaded' : 'warning', error ? 'destructive' : 'outline', true) +
    '<div class="list-row-grow">' +
      '<div class="list-row-title">' + esc(issue.skill) +
        ' <span class="issue-path">' + esc(relativeTo(issue.path, root)) + '</span></div>' +
      '<div class="issue-message">' + esc(relativeTo(issue.message, root)) + '</div>' +
    '</div>' +
  '</div>';
}

function skillIssuesCard(data) {
  if (data.issues.length === 0) return '';
  // Errors first: those are the skills that did not load at all.
  const ordered = [...data.issues].sort(
    (a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1));

  return ui.card('Problems',
    ui.list(ordered.map((i) => skillIssueRow(i, data.root)).join(''), 'Skill problems'),
    { aside: ui.badge(data.counts.errors + ' / ' + data.counts.warnings,
        data.counts.errors > 0 ? 'destructive' : 'outline') });
}

function matchingSkills(data) {
  const filter = (state.skillFilter || '').toLowerCase();
  if (!filter) return data.skills;
  return data.skills.filter((s) =>
    s.name.toLowerCase().includes(filter) || s.description.toLowerCase().includes(filter));
}

/**
 * Just the grouped list, so filtering can redraw it without losing focus.
 *
 * Each scope is its own list: role="list" around the scope's items, with the
 * "user"/"project"/"bundled" header line kept outside it as a heading-ish
 * label rather than a member. Each item is a <button> — giving the button
 * itself role="listitem" would replace its implicit role="button" outright,
 * so it is wrapped in a plain <div role="listitem"> instead, which costs
 * nothing visually (an unclassed div has no box of its own to change the
 * layout) and keeps "button" as what a screen reader calls it.
 */
function skillGroups(data) {
  const matches = matchingSkills(data);
  // Yours first: the bundled 29 are the ones you are least likely to want.
  const groups = ['user', 'project', 'bundled'].map((scope) => {
    const inScope = matches.filter((s) => s.scope === scope);
    if (inScope.length === 0) return '';
    return '<div class="skill-group"><span class="silk">' + scope + '</span>' +
      '<span class="nav-count">' + inScope.length + '</span></div>' +
      ui.list(inScope.map((s) => {
        // "page" is the correct ARIA token for the current item in a
        // nav-like list, omitted (not written "false") on every other row —
        // styles.ts's .skill-item rule already matches both "true" and
        // "page" (added alongside app-authored.ts's agent rows, which use
        // the same class), so this can use the right token directly rather
        // than the .nav-item/.toc-item compromise elsewhere in this pass.
        const current = state.skill && state.skill.name === s.name;
        return '<div role="listitem"><button class="skill-item" data-skill-open="' + esc(s.name) + '"' +
          (current ? ' aria-current="page"' : '') + '>' +
          '<span class="skill-item-name">' + esc(s.name) + '</span>' +
          '<span class="skill-item-desc">' + esc(s.description || 'no description') + '</span>' +
        '</button></div>';
      }).join(''), scope + ' skills');
  }).join('');

  return groups || ui.empty(state.skillFilter ? 'Nothing matches that.' : 'No skills resolved.');
}

function skillListCard(data) {
  const search = '<div class="skill-search">' +
    '<input class="input" type="search" id="skill-filter" placeholder="Name or description" ' +
      'value="' + esc(state.skillFilter || '') + '" aria-label="Filter skills"></div>';

  return ui.card('Resolved',
    search + '<div class="skill-list-body">' + skillGroups(data) + '</div>',
    { aside: ui.badge(matchingSkills(data).length + ' of ' + data.skills.length, 'secondary') });
}

function skillDetailCard() {
  const s = state.skill;
  if (!s) {
    return ui.card('Skill', ui.empty('Pick a skill to read it, or write a new one below.'));
  }

  const d = state.skillDraft;
  const dirty = skillDirty();

  if (!s.editable) {
    return ui.card(s.name,
      '<div class="card-content">' +
        '<p class="form-hint mb">' + esc(SCOPE_NOTE[s.scope] || '') + '</p>' +
        '<p class="skill-readonly-desc">' + esc(s.description) + '</p>' +
        '<pre class="code-block skill-prompt">' + esc(s.prompt) + '</pre>' +
      '</div>',
      { aside: ui.badge(s.scope, SCOPE_BADGE[s.scope] || 'muted') });
  }

  return ui.card(s.name,
    '<div class="card-content">' +
      '<label class="label" for="skill-desc">Description</label>' +
      '<p class="form-hint mb">The one line the picker shows when you type /skill.</p>' +
      '<input class="input mb" type="text" id="skill-desc" value="' + esc(d.description) + '">' +
      '<label class="label" for="skill-body">Prompt</label>' +
      '<p class="form-hint mb">Sent as a message when the skill runs.</p>' +
      '<textarea class="textarea" id="skill-body" spellcheck="false">' + esc(d.prompt) + '</textarea>' +
      '<div class="section-actions mt">' +
        ui.btn('Save', { variant: 'default', attrs: ' data-action="skill-save"', disabled: !dirty }) +
        ui.btn('Revert', { attrs: ' data-action="skill-revert"', disabled: !dirty }) +
        ui.btn('Delete skill', { variant: 'destructive-ghost', attrs: ' data-action="skill-delete"' }) +
      '</div>' +
    '</div>',
    { aside: ui.badge(dirty ? 'unsaved' : s.scope, dirty ? 'destructive' : SCOPE_BADGE[s.scope], dirty) });
}

// Both fields are genuinely required — createSkill() above refuses to submit
// without them — so both carry required/aria-required, and each gets its own
// empty (until there is something to say) role="alert" node wired in by
// aria-describedby, the same pattern as Settings' fields in app-settings.ts.
// Each input is wrapped in a bare div rather than sitting beside its error as
// a third sibling: .form-grid places children two per row (label, control),
// and a third child per field would throw that alternation off. A div with
// no class of its own does not change what .form-grid sees — it is still one
// grid item occupying the control column, sized to its content exactly like
// the bare input was.
function skillCreateCard() {
  return ui.card('New skill',
    '<div class="card-content"><div class="form-grid">' +
      '<label class="label" for="skill-name">Name</label>' +
      '<div><input class="input" type="text" id="skill-name" placeholder="deploy" ' +
        'required aria-required="true" aria-describedby="skill-name-error">' +
        '<div id="skill-name-error" role="alert"></div></div>' +
      '<label class="label" for="skill-description">Description</label>' +
      '<div><input class="input" type="text" id="skill-description" placeholder="When to reach for it" ' +
        'required aria-required="true" aria-describedby="skill-description-error">' +
        '<div id="skill-description-error" role="alert"></div></div>' +
      '<div class="form-span section-actions">' +
        ui.btn('Create', { variant: 'default', attrs: ' data-action="skill-create"' }) +
        '<span class="form-hint">Written to its own directory as SKILL.md.</span>' +
      '</div>' +
    '</div></div>');
}

function viewSkills() {
  const data = state.skills;
  const header = ui.pageHeader('Skills',
    'Reusable prompts the agent loads on demand. Bundled ones ship with Asterisk; yours override ' +
    'them by name, and a project can override both.',
    data ? data.root : '');

  if (!data) return header + '<section class="card">' + ui.skeletonRows(4) + '</section>';

  const summary = '<div class="section-actions mb">' +
    ui.badge(data.counts.loaded + ' loaded', 'secondary') +
    ui.badge(data.counts.bundled + ' bundled', 'muted') +
    (data.counts.errors > 0 ? ui.badge(data.counts.errors + ' not loaded', 'destructive', true) : '') +
    (data.counts.warnings > 0 ? ui.badge(data.counts.warnings + ' warning' +
      (data.counts.warnings === 1 ? '' : 's'), 'outline', true) : '') +
    (data.bundledIssues.length > 0
      ? ui.badge(data.bundledIssues.length + ' bundled problems — please report', 'destructive', true)
      : '') +
  '</div>';

  return header + summary + skillIssuesCard(data) +
    '<div class="editor-grid"><div>' + skillListCard(data) + skillCreateCard() + '</div>' +
    '<div>' + skillDetailCard() + '</div></div>';
}
`;
