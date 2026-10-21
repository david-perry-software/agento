// @ts-check
// The model-profile editor webview script. Plain browser JS, no modules and no
// remote resources: it renders the form from host `state` messages, keeps the
// draft and the base hash in `vscode.setState`, posts only schema-conforming
// messages, and debounces `validate` while typing.
(function () {
  "use strict";

  /** @type {{ postMessage: (msg: unknown) => void, getState: () => unknown, setState: (s: unknown) => void }} */
  const vscode = acquireVsCodeApi();

  const root = document.getElementById("root");
  if (!root) {
    throw new Error("profileEditor.js: missing #root element");
  }

  /**
   * @typedef {Object} Form
   * @property {string} name
   * @property {string} description
   * @property {string[]} default
   * @property {Record<string, string[]>} agents
   * @property {Record<string, string[]>} prompts
   */

  /**
   * @typedef {Object} Choice
   * @property {string|null} id
   * @property {string} name
   * @property {string} vendor
   * @property {string} label
   */

  /**
   * @typedef {Object} EditorState
   * @property {string} name
   * @property {Form} form
   * @property {{ agents: string[], prompts: string[] }} pinnable
   * @property {Choice[]} choices
   * @property {Record<string, string>} copilotModels
   * @property {string|null} hash
   * @property {string[]} unknownKeys
   */

  /** @type {EditorState | null} */
  let state = null;
  /** @type {Form | null} */
  let draft = null;
  /** @type {string | null} */
  let baseHash = null;
  let dirty = false;
  /** @type {string[]} */
  let errors = [];
  /** @type {string[]} */
  let warnings = [];
  /** @type {string[] | null} */
  let conflict = null;
  let deleted = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let validateTimer = null;

  function post(message) {
    vscode.postMessage(message);
  }

  /** @returns {Form} */
  function formFromDraft() {
    if (!draft) {
      throw new Error("draft is not initialised");
    }
    return {
      name: draft.name,
      description: draft.description,
      default: draft.default,
      agents: draft.agents,
      prompts: draft.prompts,
    };
  }

  function scheduleValidate() {
    if (validateTimer !== null) {
      clearTimeout(validateTimer);
    }
    validateTimer = setTimeout(() => {
      validateTimer = null;
      post({ type: "validate", form: formFromDraft() });
    }, 400);
  }

  function persistDraft() {
    vscode.setState({ draft, baseHash });
  }

  function markDirty() {
    if (!dirty) {
      dirty = true;
      renderTitle();
    }
    persistDraft();
    post({ type: "change", form: formFromDraft(), dirty });
    scheduleValidate();
  }

  function setDraft(next) {
    draft = next;
    persistDraft();
    post({ type: "change", form: formFromDraft(), dirty });
    scheduleValidate();
  }

  function setClean() {
    dirty = false;
    renderTitle();
    persistDraft();
    post({ type: "change", form: formFromDraft(), dirty: false });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, title, onClick) {
    const node = el("button", "btn", text);
    node.type = "button";
    node.title = title;
    node.addEventListener("click", onClick);
    return node;
  }

  function datalist(choices) {
    const node = document.createElement("datalist");
    node.id = "model-choices";
    for (const choice of choices) {
      const option = document.createElement("option");
      option.value = choice.label;
      node.appendChild(option);
    }
    return node;
  }

  /** @param {string} value */
  function aliasHintHtml(value) {
    if (!state) return null;
    const aliases = state.copilotModels;
    if (typeof aliases[value] === "string" && aliases[value]) {
      const hint = el("span", "alias-hint alias-existing", `alias: ${aliases[value]}`);
      hint.appendChild(button("Add alias", "Write this alias to copilotModels", () => post({ type: "addAlias", value, id: aliases[value] })));
      return hint;
    }
    const choice = state.choices.find((c) => c.label === value);
    if (choice && choice.id) {
      let id = choice.id;
      if (choice.vendor !== "copilot" && !id.includes("/")) id = `${choice.vendor}/${id}`;
      const hint = el("span", "alias-hint alias-suggested", `suggest alias: ${id}`);
      hint.appendChild(button("Add alias", "Write this alias to copilotModels", () => post({ type: "addAlias", value, id })));
      return hint;
    }
    return el("span", "alias-hint alias-none", "");
  }

  /**
   * A model value field: one or more datalist-backed inputs with add, remove, and
   * reorder controls for a fallback list. `getValue` always reads the live draft,
   * so the controls never act on a stale copy.
   * @param {() => string[]} getValue
   * @param {(next: string[]) => void} onChange
   */
  function valueField(getValue, onChange) {
    const wrap = el("div", "value-field");
    const rows = el("div", "value-rows");
    const renderRows = () => {
      rows.textContent = "";
      const entries = getValue().slice();
      if (!entries.length) entries.push("");
      entries.forEach((entry, index) => {
        const row = el("div", "value-row");
        const input = document.createElement("input");
        input.type = "text";
        input.value = entry;
        input.setAttribute("list", "model-choices");
        input.setAttribute("autocomplete", "off");
        input.setAttribute("spellcheck", "false");
        input.addEventListener("input", () => {
          entries[index] = input.value;
          onChange(entries.filter((v, i) => i < entries.length - 1 || v !== ""));
          updateAliasHints();
        });
        row.appendChild(input);
        row.appendChild(aliasHintHtml(entry));
        if (entries.length > 1) {
          row.appendChild(button("−", "Remove this entry", () => {
            entries.splice(index, 1);
            onChange(entries.slice());
            renderRows();
          }));
        }
        row.appendChild(button("↑", "Move up", () => {
          if (index === 0) return;
          [entries[index - 1], entries[index]] = [entries[index], entries[index - 1]];
          onChange(entries.slice());
          renderRows();
        }));
        row.appendChild(button("↓", "Move down", () => {
          if (index === entries.length - 1) return;
          [entries[index + 1], entries[index]] = [entries[index], entries[index + 1]];
          onChange(entries.slice());
          renderRows();
        }));
        rows.appendChild(row);
      });
    };
    renderRows();
    wrap.appendChild(rows);
    wrap.appendChild(button("+ Add fallback", "Add another model to the ordered fallback list", () => {
      onChange([...getValue(), ""]);
      renderRows();
    }));
    return wrap;
  }

  function agentField(alias, getValue, onChange) {
    const fieldset = el("div", "agent-field");
    fieldset.appendChild(el("span", "field-label", alias));
    fieldset.appendChild(valueField(getValue, onChange));
    return fieldset;
  }

  function renderUnknownNotice() {
    if (!state || !state.unknownKeys.length) return null;
    const notice = el("div", "unknown-notice");
    notice.appendChild(el("strong", null, "Unknown fields kept"));
    notice.appendChild(el("span", null, ` The stored profile has fields this editor does not edit (${state.unknownKeys.join(", ")}); they are preserved on save.`));
    return notice;
  }

  function renderErrors() {
    const box = el("div", "feedback");
    for (const message of errors) box.appendChild(el("div", "error", message));
    for (const message of warnings) box.appendChild(el("div", "warning", message));
    return errors.length || warnings.length ? box : null;
  }

  function renderConflict() {
    if (!conflict) return null;
    const banner = el("div", "conflict-banner");
    banner.appendChild(el("strong", null, "The profiles file changed"));
    banner.appendChild(el("span", null, ` (${conflict.join(", ")}). Your draft was not overwritten.`));
    banner.appendChild(button("Reload", "Discard the draft and load the latest version", () => {
      conflict = null;
      post({ type: "reload" });
    }));
    return banner;
  }

  function renderDeleted() {
    if (!deleted) return null;
    const banner = el("div", "deleted-banner");
    banner.appendChild(el("strong", null, "This profile was deleted elsewhere"));
    banner.appendChild(el("span", null, " Close the panel, or open the profiles file to recreate it."));
    return banner;
  }

  function renderTitle() {
    if (!state) return;
    document.title = `${dirty ? "● " : ""}Profile: ${state.name}`;
    const heading = document.getElementById("editor-heading");
    if (heading) heading.textContent = `${dirty ? "● " : ""}Profile: ${state.name}`;
  }

  function renderForm() {
    if (!state || !draft) return;
    root.textContent = "";

    const heading = el("h1", "heading");
    heading.id = "editor-heading";
    root.appendChild(heading);

    const conflictNode = renderConflict();
    if (conflictNode) root.appendChild(conflictNode);
    const deletedNode = renderDeleted();
    if (deletedNode) root.appendChild(deletedNode);

    const unknown = renderUnknownNotice();
    if (unknown) root.appendChild(unknown);

    if (state.choices.length === 0) {
      const hint = el("div", "empty-models");
      hint.appendChild(el("span", null, "No models reported by VS Code — type a model name such as "));
      hint.appendChild(el("code", null, "Claude Opus 4.5 (copilot)"));
      hint.appendChild(el("span", null, "."));
      root.appendChild(hint);
    }

    root.appendChild(datalist(state.choices));

    const form = el("div", "editor-form");

    const nameField = el("label", "field");
    nameField.appendChild(el("span", "field-label", "Name"));
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = draft.name;
    nameInput.addEventListener("input", () => {
      draft.name = nameInput.value;
      markDirty();
    });
    nameField.appendChild(nameInput);
    form.appendChild(nameField);

    const descriptionField = el("label", "field");
    descriptionField.appendChild(el("span", "field-label", "Description"));
    const descriptionInput = document.createElement("input");
    descriptionInput.type = "text";
    descriptionInput.value = draft.description;
    descriptionInput.addEventListener("input", () => {
      draft.description = descriptionInput.value;
      markDirty();
    });
    descriptionField.appendChild(descriptionInput);
    form.appendChild(descriptionField);

    const defaultField = el("div", "field");
    defaultField.appendChild(el("span", "field-label", "Default model"));
    defaultField.appendChild(valueField(() => draft.default, (next) => {
      draft.default = next;
      markDirty();
    }));
    form.appendChild(defaultField);

    const agents = el("div", "field");
    agents.appendChild(el("span", "field-label", "Agents"));
    for (const alias of state.pinnable.agents) {
      agents.appendChild(agentField(alias, () => draft.agents[alias] ?? [], (next) => {
        draft.agents[alias] = next;
        markDirty();
      }));
    }
    form.appendChild(agents);

    const overrides = el("div", "field");
    overrides.appendChild(el("span", "field-label", "Command overrides"));
    for (const command of Object.keys(draft.prompts)) {
      overrides.appendChild(agentField(command, () => draft.prompts[command] ?? [], (next) => {
        draft.prompts[command] = next;
        markDirty();
      }));
    }
    const unused = state.pinnable.prompts.filter((command) => !Object.hasOwn(draft.prompts, command));
    if (unused.length) {
      const addRow = el("div", "add-override");
      const select = document.createElement("select");
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Add override…";
      select.appendChild(placeholder);
      for (const command of unused) {
        const option = document.createElement("option");
        option.value = command;
        option.textContent = command;
        select.appendChild(option);
      }
      select.addEventListener("change", () => {
        if (!select.value) return;
        draft.prompts[select.value] = [""];
        setDraft(draft);
        renderForm();
      });
      addRow.appendChild(select);
      overrides.appendChild(addRow);
    }
    form.appendChild(overrides);

    root.appendChild(form);

    const feedback = renderErrors();
    if (feedback) root.appendChild(feedback);

    const footer = el("div", "footer");
    footer.appendChild(button("Save", "Validate and write the profile through the CLI", () => post({ type: "save", form: formFromDraft() })));
    footer.appendChild(button("Save & Apply", "Save, then apply the profile to this clone", () => post({ type: "saveAndApply", form: formFromDraft() })));
    footer.appendChild(button("Open file", "Open the profiles file for raw editing", () => post({ type: "openFile" })));
    root.appendChild(footer);

    renderTitle();
  }

  function updateAliasHints() {
    if (!state || !draft) return;
    const inputs = Array.from(root.querySelectorAll("input[list='model-choices']"));
    for (const input of inputs) {
      const value = input.value;
      const row = input.closest(".value-row");
      if (!row) continue;
      const existing = row.querySelector(".alias-hint");
      if (existing) existing.remove();
      if (value) row.appendChild(aliasHintHtml(value));
    }
  }

  function renderFeedback() {
    const existing = root.querySelector(".feedback");
    if (existing) existing.remove();
    const node = renderErrors();
    if (node) root.insertBefore(node, root.querySelector(".footer"));
  }

  function receiveState(next) {
    state = next;
    draft = next.form;
    baseHash = next.hash;
    dirty = false;
    errors = [];
    warnings = [];
    conflict = null;
    deleted = false;
    renderForm();
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "state") {
      receiveState(message);
    } else if (message.type === "validateResult") {
      errors = Array.isArray(message.errors) ? message.errors : [];
      warnings = Array.isArray(message.warnings) ? message.warnings : [];
      renderFeedback();
    } else if (message.type === "conflict") {
      conflict = Array.isArray(message.changed) ? message.changed : [];
      renderForm();
    } else if (message.type === "deleted") {
      deleted = true;
      renderForm();
    } else if (message.type === "saved") {
      // The host re-posts `state` with the new body and hash; nothing to do here.
    }
  });

  // Restore the draft and hash kept across hidden-panel re-renders, then ask the
  // host for the latest state.
  const saved = vscode.getState();
  if (saved && typeof saved === "object" && saved.draft) {
    draft = saved.draft;
    baseHash = saved.baseHash ?? null;
  }
  post({ type: "ready" });
})();
