// dsh-memory — browser half: the plugin-configuration card for the
// `dsh-memory` settings namespace, registered into `settings.plugin.item`
// (the "Plugin configuration" tab of the Plugins settings section).
//
// Hand-written in the client bundle format (window.__ModuleLoader__.load),
// the same shape the official `lib/client.js` artifacts ship, so no build
// step is needed: only `react` and `react/jsx-runtime` are required, both
// shell seed words the official bundles already use.
//
// Data channel: the official card machinery (settingsScope) only serves
// namespaces on an api-proxy whitelist hardcoded in upstream packages, so
// this card reads and writes through the plugin's OWN webServer endpoint
// (/dsh-memory/config, registered by the host half). Same-origin fetch, no
// upstream package touched.
//
// The card stages edits locally and writes them on Save; a rejected write
// keeps the drafts so the user can correct them.

window.__ModuleLoader__.load({
  id: "dsh-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    // ── locale copy ──────────────────────────────────────────────────────────
    const en = {
      title: "Memory (dsh-memory)",
      description: "Cross-session memory: background Auto-Memory, memory_search, and Dream consolidation.",
      searchLimit: "Search result limit",
      searchLimitHint: "Default result count for memory_search (1-10).",
      model: "Dream model override",
      modelHint: "provider/model for Dream LLM calls; blank uses the session model.",
      dreamTime: "Dream trigger time",
      dreamTimeHint: "Daily trigger time, HH:MM; blank = timer off (/dream still works).",
      embeddingBaseUrl: "Embedding base URL",
      embeddingBaseUrlHint: "Ollama base URL (e.g. http://localhost:11434) for vector search; blank disables it.",
      embeddingModel: "Embedding model",
      embeddingModelHint: "Embedding model name served by the base URL (e.g. bge-m3).",
      autoMemory: "Auto-Memory",
      autoMemoryHint: "Each turn the agent decides for itself whether anything worth keeping happened and writes it to today's memory file; off = no per-turn reminder.",
      overridden: "Overridden",
      reset: "Reset to default",
      save: "Save",
      saving: "Saving…",
      discard: "Discard",
      unsaved: "Unsaved",
      readOnly: "This deployment stores settings read-only.",
      invalid: "Enter a number, or leave blank to use the default.",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
      loadFailed: "Could not read the memory configuration.",
      expand: "Show settings",
      collapse: "Hide settings"
    };
    const zh = {
      title: "记忆（dsh-memory）",
      description: "跨会话记忆：后台 Auto-Memory 自动捕获、memory_search 检索与 Dream 长期巩固。",
      searchLimit: "搜索返回条数",
      searchLimitHint: "memory_search 默认返回条数（1-10）。",
      model: "Dream 模型覆盖",
      modelHint: "Dream LLM 的 provider/model；留空 = 会话模型。",
      dreamTime: "Dream 触发时间",
      dreamTimeHint: "每日触发时间，HH:MM；留空 = 关闭定时（/dream 手动仍可用）。",
      embeddingBaseUrl: "向量嵌入服务地址",
      embeddingBaseUrlHint: "Ollama 基地址（如 http://localhost:11434），用于向量检索；留空禁用。",
      embeddingModel: "嵌入模型",
      embeddingModelHint: "该服务上的嵌入模型名（如 bge-m3）。",
      autoMemory: "自动记忆",
      autoMemoryHint: "每轮由 agent 自行判断是否有值得记忆的新内容并写入当日记忆文件；关闭后不再每轮提醒。",
      overridden: "已覆盖",
      reset: "恢复默认",
      save: "保存",
      saving: "保存中…",
      discard: "放弃修改",
      unsaved: "未保存",
      readOnly: "本部署的设置为只读。",
      invalid: "请填数字；留空表示使用默认值。",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
      loadFailed: "无法读取记忆插件配置。",
      expand: "展开设置",
      collapse: "收起设置"
    };
    const lang = typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "") ? zh : en;
    const t = (key) => lang[key] ?? key;

    /** Section fields this card edits: kind is number | bool | text. */
    const FIELDS = [
      { field: "searchLimit", kind: "number", label: "searchLimit", hint: "searchLimitHint" },
      { field: "model", kind: "text", label: "model", hint: "modelHint" },
      { field: "dreamTime", kind: "text", label: "dreamTime", hint: "dreamTimeHint" },
      { field: "embeddingBaseUrl", kind: "text", label: "embeddingBaseUrl", hint: "embeddingBaseUrlHint" },
      { field: "embeddingModel", kind: "text", label: "embeddingModel", hint: "embeddingModelHint" },
      { field: "autoMemory", kind: "bool", label: "autoMemory", hint: "autoMemoryHint" }
    ];

    // ── theme-aligned styles (dsw alias tokens, as the official cards use) ──
    const styles = {
      card: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: 12, listStyle: "none" },
      cardOpen: { background: "var(--dsw-alias-bg-layer-2)", borderColor: "var(--dsw-alias-label-dimmed)" },
      header: { appearance: "none", width: "100%", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", background: "none", border: 0, borderRadius: 12, alignItems: "center", gap: 12, padding: "14px 16px", display: "flex" },
      headText: { flexDirection: "column", flex: 1, gap: 4, minWidth: 0, display: "flex" },
      name: { color: "var(--dsw-alias-label-primary)", fontSize: 15, fontWeight: 600, lineHeight: 1.4 },
      description: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: 1.5 },
      pending: { whiteSpace: "nowrap", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", borderRadius: 999, flex: "none", padding: "1px 8px", fontSize: 11, fontWeight: 500, lineHeight: 17 },
      chevron: { color: "var(--dsw-alias-label-tertiary)", flex: "none", transition: "transform .16s", display: "block" },
      chevronOpen: { transform: "rotate(180deg)" },
      body: { borderTop: "1px solid var(--dsw-alias-border-l2)", margin: "0 16px", paddingBottom: 8 },
      readOnly: { color: "var(--dsw-alias-label-tertiary)", margin: "12px 0 0", fontSize: 12, lineHeight: 1.5 },
      error: { color: "var(--dsw-alias-label-error)", margin: "12px 0 0", fontSize: 12, lineHeight: 1.5 },
      field: { flexDirection: "column", gap: 6, padding: "12px 0", display: "flex" },
      fieldBorder: { borderTop: "1px solid var(--dsw-alias-border-l2)" },
      head: { alignItems: "center", gap: 8, display: "flex" },
      label: { minWidth: 0, color: "var(--dsw-alias-label-primary)", flex: 1, fontSize: 13, fontWeight: 500, lineHeight: 1.5 },
      // badge + reset pin the row height: the label line is 19.5px, so the
      // override row must never exceed it regardless of inherited font rules
      badges: { alignItems: "center", gap: 8, display: "inline-flex", flex: "none", height: 19 },
      // the official cards' badge style (solid pill, bg-module-platform)
      badge: { whiteSpace: "nowrap", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", borderRadius: 999, padding: "1px 8px", fontSize: 11, fontWeight: 500, lineHeight: 17, height: 19, boxSizing: "border-box", display: "inline-flex", alignItems: "center" },
      reset: { font: "inherit", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", background: "none", border: "none", padding: 0, fontSize: 12, lineHeight: 1.5, height: 18, boxSizing: "border-box", display: "inline-flex", alignItems: "center" },
      input: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", height: 34, font: "inherit", color: "var(--dsw-alias-label-primary)", borderRadius: 8, padding: "0 12px", fontSize: 13, lineHeight: 1.5, width: "100%", boxSizing: "border-box" },
      inputInvalid: { borderColor: "var(--dsw-alias-label-error)" },
      checkbox: { width: 16, height: 16, accentColor: "var(--dsw-alias-brand-primary)" },
      hint: { color: "var(--dsw-alias-label-tertiary)", margin: 0, fontSize: 12, lineHeight: 1.5 },
      invalidText: { color: "var(--dsw-alias-label-error)", margin: 0, fontSize: 12, lineHeight: 1.5 },
      footer: { borderTop: "1px solid var(--dsw-alias-border-l2)", justifyContent: "flex-end", alignItems: "center", gap: 8, padding: "12px 0 4px", display: "flex" },
      failed: { minWidth: 0, color: "var(--dsw-alias-label-error)", flex: 1, margin: 0, fontSize: 12, lineHeight: 1.5 },
      discardBtn: { appearance: "none", font: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)", background: "none", borderRadius: 8, padding: "5px 14px", fontSize: 13, lineHeight: 1.5 },
      saveBtn: { appearance: "none", font: "inherit", cursor: "pointer", border: "1px solid transparent", borderRadius: 8, padding: "5px 14px", fontSize: 13, lineHeight: 1.5, background: "var(--dsw-alias-brand-primary)", color: "#fff" },
      disabled: { opacity: 0.5, cursor: "default" }
    };

    /** The card's data channel: the host half's /dsh-memory/config endpoint. */
    const api = {
      async get() {
        const res = await fetch("/dsh-memory/config");
        if (!res.ok) throw new Error(`config read failed (${res.status})`);
        return res.json();
      },
      async update(ops) {
        const res = await fetch("/dsh-memory/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ops })
        });
        if (!res.ok) {
          let message = `config write failed (${res.status})`;
          try {
            const body = await res.json();
            if (body && typeof body.error === "string") message = body.error;
          } catch {}
          throw new Error(message);
        }
        return res.json();
      }
    };

    /**
     * One plugin's card: a header naming the plugin and what its settings
     * govern, the staged field controls, and the save that writes them.
     * @param props - the slot-injected face ({ api }) merged by the renderer.
     * @returns the card.
     */
    function MemoryCard(props) {
      const [state, setState] = react.useState({ status: "loading" });
      const [drafts, setDrafts] = react.useState({});
      const [saving, setSaving] = react.useState(false);
      const [failure, setFailure] = react.useState(null);
      const [open, setOpen] = react.useState(false);

      react.useEffect(() => {
        let alive = true;
        api.get()
          .then((snapshot) => { if (alive) setState({ status: "ready", ...snapshot }); })
          .catch((error) => { if (alive) setState({ status: "error", error: String(error && error.message ? error.message : error) }); });
        return () => { alive = false; };
      }, []);

      if (state.status === "loading") return null;
      const title = t("title");
      const value = state.value ?? {};
      const user = state.user;
      const writable = state.writable === true;
      const error = state.error;

      const overridden = (field) => user !== undefined && user !== null && typeof user === "object" && Object.prototype.hasOwnProperty.call(user, field);

      const effective = (field) => {
        const draft = drafts[field];
        if (draft !== undefined) return draft.text;
        const v = value[field];
        return v === undefined || v === null ? "" : String(v);
      };

      const edit = (field, text) => {
        setDrafts((d) => ({ ...d, [field]: { text } }));
        setFailure(null);
      };
      const resetField = (field) => {
        setDrafts((d) => ({ ...d, [field]: { clear: true, text: "" } }));
        setFailure(null);
      };
      const discard = () => {
        setDrafts({});
        setFailure(null);
      };

      const specOf = (field) => FIELDS.find((f) => f.field === field);
      /** Turn one staged draft into a write plan; null = the draft is invalid. */
      const parse = (spec, draft) => {
        if (draft.clear) return { kind: "clear" };
        const text = (draft.text ?? "").trim();
        if (spec.kind === "number") {
          if (text === "") return { kind: "clear" };
          const n = Number(text);
          if (!Number.isFinite(n)) return null;
          return { kind: "set", value: n };
        }
        if (spec.kind === "bool") return { kind: "set", value: text === "true" };
        return text === "" ? { kind: "clear" } : { kind: "set", value: text };
      };

      const dirty = Object.keys(drafts).length > 0;
      const invalid = Object.entries(drafts).some(([field, draft]) => parse(specOf(field), draft) === null);
      const blocked = !dirty || invalid || saving;

      const save = async () => {
        if (blocked) return;
        const ops = [];
        for (const [field, draft] of Object.entries(drafts)) {
          const plan = parse(specOf(field), draft);
          if (plan === null) return;
          ops.push(plan.kind === "clear" ? { op: "unset", field } : { op: "set", field, value: plan.value });
        }
        setSaving(true);
        setFailure(null);
        try {
          await api.update(ops);
          const fresh = await api.get();
          setDrafts({});
          setState({ status: "ready", ...fresh });
        } catch (err) {
          setFailure(String(err && err.message ? err.message : err));
        } finally {
          setSaving(false);
        }
      };

      const renderField = (spec, first) => {
        const field = spec.field;
        const draft = drafts[field];
        const text = effective(field);
        const fieldInvalid = draft !== undefined && parse(spec, draft) === null;
        const rowStyle = { ...styles.field, ...(first ? {} : styles.fieldBorder) };
        const control = spec.kind === "bool"
          ? react_jsx_runtime.jsx("input", {
              type: "checkbox",
              style: styles.checkbox,
              checked: text === "true",
              disabled: !writable,
              onChange: () => edit(field, text === "true" ? "false" : "true")
            }, field)
          : react_jsx_runtime.jsx("input", {
              id: `dsh-memory-${field}`,
              className: "dshm-input",
              style: { ...styles.input, ...(fieldInvalid ? styles.inputInvalid : {}) },
              type: "text",
              ...(spec.kind === "number" ? { inputMode: "numeric" } : {}),
              ...(fieldInvalid ? { "aria-invalid": true } : {}),
              value: text,
              disabled: !writable,
              onChange: (event) => edit(field, event.target.value)
            }, field);
        return react_jsx_runtime.jsxs("div", {
          style: rowStyle,
          children: [
            react_jsx_runtime.jsxs("div", {
              style: styles.head,
              children: [
                react_jsx_runtime.jsx("label", { style: styles.label, htmlFor: `dsh-memory-${field}`, children: t(spec.label) }),
                overridden(field) ? react_jsx_runtime.jsxs("span", {
                  style: styles.badges,
                  children: [
                    react_jsx_runtime.jsx("span", { style: styles.badge, children: t("overridden") }),
                    react_jsx_runtime.jsx("button", { type: "button", className: "dshm-reset", style: styles.reset, disabled: !writable, onClick: () => resetField(field), children: t("reset") })
                  ]
                }) : null
              ]
            }),
            control,
            react_jsx_runtime.jsx("p", { style: fieldInvalid ? styles.invalidText : styles.hint, children: t(fieldInvalid ? "invalid" : spec.hint) })
          ]
        }, field);
      };

      return react_jsx_runtime.jsxs("li", {
        style: { ...styles.card, ...(open ? styles.cardOpen : {}) },
        children: [
          react_jsx_runtime.jsxs("button", {
            type: "button",
            style: styles.header,
            "aria-expanded": open,
            "aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
            onClick: () => setOpen(!open),
            children: [
              react_jsx_runtime.jsxs("span", {
                style: styles.headText,
                children: [
                  react_jsx_runtime.jsx("span", { style: styles.name, children: title }),
                  react_jsx_runtime.jsx("span", { style: styles.description, children: t("description") })
                ]
              }),
              dirty ? react_jsx_runtime.jsx("span", { style: styles.pending, children: t("unsaved") }) : null,
              // the official IconChevronDownOutline14 (14px, rotates when open)
              react_jsx_runtime.jsx("svg", {
                width: 14,
                height: 14,
                viewBox: "0 0 14 14",
                fill: "none",
                xmlns: "http://www.w3.org/2000/svg",
                "aria-hidden": true,
                style: { ...styles.chevron, ...(open ? styles.chevronOpen : {}) },
                children: react_jsx_runtime.jsx("path", {
                  d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
                  fill: "currentColor"
                })
              })
            ]
          }),
          open ? react_jsx_runtime.jsxs("div", {
            style: styles.body,
            children: [
              error ? react_jsx_runtime.jsx("p", { style: styles.error, role: "status", children: `${t("loadFailed")} ${error}` }) : null,
              !writable ? react_jsx_runtime.jsx("p", { style: styles.readOnly, role: "status", children: t("readOnly") }) : null,
              error ? null : FIELDS.map((spec, index) => renderField(spec, index === 0)),
              error ? null : react_jsx_runtime.jsxs("div", {
                style: styles.footer,
                children: [
                  failure ? react_jsx_runtime.jsx("p", { style: styles.failed, role: "status", children: `${t("saveFailed")} ${failure}` }) : null,
                  react_jsx_runtime.jsx("button", { type: "button", style: styles.discardBtn, disabled: !dirty || saving, onClick: discard, children: t("discard") }),
                  react_jsx_runtime.jsx("button", {
                    type: "button",
                    style: { ...styles.saveBtn, ...(blocked ? styles.disabled : {}) },
                    disabled: blocked,
                    onClick: save,
                    children: t(saving ? "saving" : "save")
                  })
                ]
              })
            ]
          }) : null
        ]
      });
    }

    /**
     * Mount the plugin-configuration card for the dsh-memory namespace.
     * @param ctx - the browser plugin context (slots).
     */
    function apply(ctx) {
      // pseudo-class styles the inline style objects cannot express
      // (hover/disabled/focus-visible), injected the same way the official
      // client packages inject their CSS modules
      if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-memory\"]") === null) {
        const tag = document.createElement("style");
        tag.dataset.pluginCss = "dsh-memory";
        tag.textContent = [
          ".dshm-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
          ".dshm-reset:disabled{cursor:default}",
          ".dshm-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
          ".dshm-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}"
        ].join("\n");
        document.head.appendChild(tag);
      }
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        id: "dsh-memory",
        order: 30,
        inject: () => ({ api })
      }, MemoryCard));
    }

    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  }
});
