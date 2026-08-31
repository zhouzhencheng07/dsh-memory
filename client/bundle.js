// dsh-memory — browser half: the plugin-configuration card for the
// `dsh-memory` settings namespace, registered into `settings.plugin.item`
// (the "Plugin configuration" tab of the Plugins settings section).
//
// Hand-written in the client bundle format (window.__ModuleLoader__.load),
// the same shape the official `lib/client.js` artifacts ship, so no build
// step is needed: only `react` and `react/jsx-runtime` are required, both
// shell seed words the official bundles already use.
//
// Data channel: the OFFICIAL client settings scope. Since dsh rc.7 removed
// the api-proxy namespace whitelist, any registered namespace can bind
// ctx.settingsScope.bind({ namespace }) — the same machinery the official
// cards use: reads ride the shared describe mirror (refreshed on document
// commits and reconnects), writes carry the latest known revision and fold
// their answers back in. The earlier hand-rolled /dsh-memory/config HTTP
// endpoint was removed with this migration.
//
// Card conventions mirror the official CardForm (dsh-client-ui-settings-
// plugins): edits stage locally and write only on Save; a field shows its
// effective value (user layer over composition base over schema default);
// "overridden" means presence in the raw user layer, not a value compare;
// a save that did not land keeps its drafts for the user to correct.
//
// The card owns its staging and revision fencing because the bundle purity
// gate forbids out-of-tree bundles importing the official card chrome and
// form models as values.

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
      description: "Cross-session memory: daily per-workspace notes, long-term topics, and recall search.",
      memoryRoot: "Memory library root",
      memoryRootHint: "Where the notes live. Blank = $DSH_HOME/dsh-memory. Changing it switches libraries — existing notes stay where they are.",
      searchLimit: "Search result limit",
      searchLimitHint: "Result count for memory recall (1-10); the agent cannot override it.",
      dailyWindowDays: "Diary search window (days)",
      dailyWindowDaysHint: "Daily notes older than this stop participating in search (0 = unlimited); files stay on disk. Long-term topic files (topics/) are never windowed.",
      embeddingBaseUrl: "Embedding base URL",
      embeddingBaseUrlHint: "Ollama base URL (e.g. http://localhost:11434) for vector search; blank disables it.",
      embeddingModel: "Embedding model",
      embeddingModelHint: "Embedding model name served by the base URL (e.g. bge-m3).",
      autoMemory: "Per-turn memory reminder",
      autoMemoryHint: "Remind every turn: when something is worth keeping across sessions, the memory tool must be used. Off = record only when asked.",
      longtermAppend: "Append long-term block",
      longtermAppendHint: "When no long-term (topics/) block is among the results, append the best-ranking one after them instead of leaving it out.",
      overridden: "Overridden",
      reset: "Reset to default",
      save: "Save",
      saving: "Saving…",
      discard: "Discard",
      unsaved: "Unsaved",
      readOnly: "This deployment stores settings read-only.",
      loading: "Reading configuration…",
      invalid: "Enter a number, or leave blank to use the default.",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
      expand: "Show settings",
      collapse: "Hide settings"
    };
    const zh = {
      title: "记忆（dsh-memory）",
      description: "跨会话记忆：每日工作区笔记、长期主题文件与 recall 检索。",
      memoryRoot: "记忆库根目录",
      memoryRootHint: "笔记存放位置。留空 = $DSH_HOME/dsh-memory。改动后会切换到另一个库——原有笔记仍留在原处。",
      searchLimit: "搜索返回条数",
      searchLimitHint: "recall 检索返回条数（1-10），agent 不可覆盖。",
      dailyWindowDays: "日记检索窗口（天）",
      dailyWindowDaysHint: "超过该天数的每日笔记不再参与检索（0=不限），文件保留在磁盘；长期主题文件（topics/）不受窗口限制。",
      embeddingBaseUrl: "向量嵌入服务地址",
      embeddingBaseUrlHint: "Ollama 基地址（如 http://localhost:11434），用于向量检索；留空禁用。",
      embeddingModel: "嵌入模型",
      embeddingModelHint: "该服务上的嵌入模型名（如 bge-m3）。",
      autoMemory: "每轮记忆提醒",
      autoMemoryHint: "每轮提醒：本轮有值得跨会话保留的内容时必须使用 memory 工具；关闭后仅在明确要求时记录。",
      longtermAppend: "长期块追加返回",
      longtermAppendHint: "结果中没有长期层（topics/）块时，在其后追加一条排名最高的长期块（不挤占名额）。",
      overridden: "已覆盖",
      reset: "恢复默认",
      save: "保存",
      saving: "保存中…",
      discard: "放弃修改",
      unsaved: "未保存",
      readOnly: "本部署的设置为只读。",
      loading: "正在读取配置…",
      invalid: "请填数字；留空表示使用默认值。",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
      expand: "展开设置",
      collapse: "收起设置"
    };
    /** 语言判定：只认 DSH 的 locale 权威 —— <html lang> 由 dsh-client-locale 的
     *  syncDocumentLanguage 在启动与每次切换时同步（设置→通用→语言），页面内
     *  恒有值（服务端标记初始为 en）。不设 navigator.language 回退：中文系统
     *  浏览器语言恒为 zh-CN，回退会把 DSH 已切到英文的界面锁回中文（dsh-kit
     *  实测过的回归根源）；且 DSH 自身无浏览器语言匹配时的兜底语义就是英文
     *  （FALLBACK_LOCALE），插件保持一致即可。非 zh 一律按英文渲染。 */
    function resolveZh() {
      if (typeof document === "undefined" || !document.documentElement) return false;
      return /^zh/i.test(document.documentElement.lang || "");
    }
    // 每次渲染现读现判，不在模块加载时钉死：DSH 的 locale 服务异步把语言同步到
    // <html lang>（syncDocumentLanguage），时机晚于本 bundle 顶层执行，一次性
    // 求值会拿到旧值而把界面锁死在英文。
    const lang = () => (resolveZh() ? zh : en);
    const t = (key) => lang()[key] ?? key;

    // 语言切换响应：外部 store + <html lang> 的 MutationObserver。DSH 异步改写
    // <html lang> 后 bump version，组件经 useSyncExternalStore 订阅 version，
    // 变化即 re-render，届时 t() 已读到新语言。与 settings scope 快照同一订阅
    // 模式（照 dsh-kit 的做法，2026-09-01）。
    const localeStore = { version: 0, listeners: new Set() };
    const subscribeLocale = (fn) => {
      localeStore.listeners.add(fn);
      return () => localeStore.listeners.delete(fn);
    };
    const getLocaleVersion = () => localeStore.version;
    if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
      let lastLang = document.documentElement.lang || "";
      new MutationObserver(() => {
        const cur = document.documentElement.lang || "";
        if (cur !== lastLang) {
          lastLang = cur;
          localeStore.version++;
          for (const l of localeStore.listeners) {
            try { l(); } catch (_e) { /* ignore */ }
          }
        }
      }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }

    /**
     * Field conversion specs, mirroring the official CardForm specs.
     *
     * format turns a stored value into control text; parse turns staged text
     * into a write plan ({kind:'set',value} | {kind:'clear'}), or undefined
     * when the draft is invalid and must block the save.
     */
    const SPECS = {
      memoryRoot: {
        kind: "text",
        label: "memoryRoot",
        hint: "memoryRootHint",
        // 恢复默认/未配置时显示为空字符串值，占位符呈现"默认是什么"而不把
        // 运行时路径误存成字面量设置（保存仍是清空=用默认）。
        placeholder: "$DSH_HOME/dsh-memory",
        format: (value) => (typeof value === "string" ? value : ""),
        parse: (text) => {
          const trimmed = text.trim();
          return trimmed === "" ? { kind: "clear" } : { kind: "set", value: trimmed };
        }
      },
      searchLimit: {
        kind: "number",
        label: "searchLimit",
        hint: "searchLimitHint",
        format: (value) => (typeof value === "number" ? String(value) : ""),
        parse: (text) => {
          const trimmed = text.trim();
          if (trimmed === "") return { kind: "clear" };
          const parsed = Number(trimmed);
          return Number.isFinite(parsed) ? { kind: "set", value: parsed } : undefined;
        }
      },
      embeddingBaseUrl: {
        kind: "text",
        label: "embeddingBaseUrl",
        hint: "embeddingBaseUrlHint",
        format: (value) => (typeof value === "string" ? value : ""),
        parse: (text) => {
          const trimmed = text.trim();
          return trimmed === "" ? { kind: "clear" } : { kind: "set", value: trimmed };
        }
      },
      dailyWindowDays: {
        kind: "number",
        label: "dailyWindowDays",
        hint: "dailyWindowDaysHint",
        format: (value) => (typeof value === "number" ? String(value) : ""),
        parse: (text) => {
          const trimmed = text.trim();
          if (trimmed === "") return { kind: "clear" };
          const parsed = Number(trimmed);
          return Number.isFinite(parsed) && parsed >= 0 ? { kind: "set", value: Math.floor(parsed) } : undefined;
        }
      },
      embeddingModel: {
        kind: "text",
        label: "embeddingModel",
        hint: "embeddingModelHint",
        format: (value) => (typeof value === "string" ? value : ""),
        parse: (text) => {
          const trimmed = text.trim();
          return trimmed === "" ? { kind: "clear" } : { kind: "set", value: trimmed };
        }
      },
      autoMemory: {
        kind: "bool",
        label: "autoMemory",
        hint: "autoMemoryHint",
        format: (value) => (value === false ? "false" : "true"),
        parse: (text) => ({ kind: "set", value: text === "true" })
      },
      longtermAppend: {
        kind: "bool",
        label: "longtermAppend",
        hint: "longtermAppendHint",
        format: (value) => (value === false ? "false" : "true"),
        parse: (text) => ({ kind: "set", value: text === "true" })
      }
      // ── autoMemory restored again 2026-08-29: the per-turn reminder is the
      // capture anchor (SHORT timing-only text; usage + organization rules in
      // the memory tool description). The 2026-08-28 AGENTS.md externalization
      // experiment was abandoned by user decision. ──
      // ── longtermAppend added 2026-08-25: the long-term append seat is now a
      // user-facing toggle (host default true = additive seat on). ──
    };
    const FIELDS = ["memoryRoot", "searchLimit", "dailyWindowDays", "embeddingBaseUrl", "embeddingModel", "autoMemory", "longtermAppend"];

    // ── theme-aligned styles (dsw alias tokens, as the official cards use) ──
    // (dropped during the migration rewrite once — the card then crashed every
    // render with "styles is not defined" and the slot renderer swallowed it,
    // leaving the card silently invisible; restored from git history)
    const styles = {
      card: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: 12, listStyle: "none" },
      cardOpen: { background: "var(--dsw-alias-bg-layer-2)", borderColor: "var(--dsw-alias-label-dimmed)" },
      header: { appearance: "none", width: "100%", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", background: "none", border: 0, borderRadius: 12, alignItems: "center", gap: 12, padding: "14px 16px", display: "flex" },
      headText: { flexDirection: "column", flex: 1, gap: 4, minWidth: 0, display: "flex" },
      name: { color: "var(--dsw-alias-label-primary)", fontSize: 15, fontWeight: 600, lineHeight: 1.4 },
      description: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: 1.5 },
      // lineHeight MUST be the string "17px": React treats numeric lineHeight
      // as a UNITLESS property (a font-size multiplier), so 17 meant 17em and
      // blew the pill up to a ~190px line box
      pending: { whiteSpace: "nowrap", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", borderRadius: 999, flex: "none", padding: "1px 8px", fontSize: 11, fontWeight: 500, lineHeight: "17px" },
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
      badge: { whiteSpace: "nowrap", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", borderRadius: 999, padding: "1px 8px", fontSize: 11, fontWeight: 500, lineHeight: "17px", height: 19, boxSizing: "border-box", display: "inline-flex", alignItems: "center" },
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

    /** The card's data channel: the bound scope face injected by apply(). */
    function MemoryCard(props) {
      const scope = props.scope;
      const [snapshot, setSnapshot] = react.useState(() => scope.getSnapshot());
      const [drafts, setDrafts] = react.useState({});
      const [saving, setSaving] = react.useState(false);
      const [failed, setFailed] = react.useState(false);
      const [open, setOpen] = react.useState(false);
      // 语言版本订阅：<html lang> 改变（DSH 设置里切换中英文）→ store version
      // bump → 本组件 re-render，届时 t() 现读 `lang()` 取到新语言。返回值本身
      // 不直接使用（订阅即是全部效果）。
      react.useSyncExternalStore(subscribeLocale, getLocaleVersion);

      react.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);

      // The card shell always renders (loading included): a silently invisible
      // card is indistinguishable from a registration/pairing failure.
      try {
        return renderCard();
      } catch (error) {
        // the slot renderer swallows render exceptions silently — surface them
        console.error("[dsh-memory] card render error:", error);
        return react_jsx_runtime.jsx("li", { style: styles.card, children: react_jsx_runtime.jsx("div", { style: styles.body, children: react_jsx_runtime.jsx("p", { style: styles.error, role: "status", children: `dsh-memory card render error: ${String(error && error.message ? error.message : error)}` }) }) });
      }

      function renderCard() {
      // The card shell always renders (loading included): a silently invisible
      // card is indistinguishable from a registration/pairing failure.
      const loading = snapshot.status === "loading";
      const title = t("title");
      const available = snapshot.status === "ready";
      const writable = snapshot.writable === true;

      /** Whether the raw user layer carries the field (the override test). */
      const stored = (field) =>
        snapshot.user !== undefined && snapshot.user !== null &&
        typeof snapshot.user === "object" && Object.prototype.hasOwnProperty.call(snapshot.user, field);

      const specOf = (field) => SPECS[field];

      /** The text a control shows with no draft: effective value, formatted. */
      const sectionText = (field) => specOf(field).format(available ? snapshot.value?.[field] : undefined);

      const stagedOf = (field) => drafts[field];

      /**
       * One field's display state: staged text wins over the stored value;
       * while staged, "overridden" previews whether saving would store an
       * override; an unparseable draft flags invalid.
       */
      const fieldState = (field) => {
        const spec = specOf(field);
        const staged = stagedOf(field);
        if (staged === undefined) {
          return { text: sectionText(field), overridden: stored(field), invalid: false };
        }
        const plan = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
        return {
          text: staged.text,
          overridden: plan !== undefined && plan.kind === "set",
          invalid: plan === undefined
        };
      };

      const edit = (field, text) => {
        setDrafts((d) => ({ ...d, [field]: { text, clear: false } }));
        setFailed(false);
      };
      // Reset stages the composition default (base layer), mirroring the
      // official form; the actual unset happens on Save.
      const resetField = (field) => {
        setDrafts((d) => ({ ...d, [field]: { text: specOf(field).format(snapshot.base?.[field]), clear: true } }));
        setFailed(false);
      };
      const discard = () => {
        setDrafts({});
        setFailed(false);
      };

      /**
       * Every write a save would perform, mirroring the official plan():
       * no-op drafts are skipped, invalid drafts block the whole save.
       * @returns array of {run} thunks, or null when a draft is invalid.
       */
      const plan = () => {
        const writes = [];
        for (const field of FIELDS) {
          const staged = stagedOf(field);
          if (staged === undefined) continue;
          const spec = specOf(field);
          if (staged.clear) {
            if (stored(field)) writes.push({ run: () => clearField(field) });
            continue;
          }
          if (staged.text === sectionText(field)) continue;
          const parsed = spec.parse(staged.text);
          if (parsed === undefined) return null;
          if (parsed.kind === "clear") writes.push({ run: () => clearField(field) });
          else writes.push({ run: () => storeField(field, parsed.value) });
        }
        return writes;
      };

      /**
       * Write one field and verify it landed by reading the section back:
       * the Host is the only authority on acceptance, and scope.set/unset
       * swallow refusals into a recovery re-read by design.
       */
      const freshUser = () => scope.getSnapshot().user;
      const storeField = async (field, value) => {
        await scope.set(field, value);
        return freshUser()?.[field] === value;
      };
      const clearField = async (field) => {
        await scope.unset(field);
        const user = freshUser();
        return !(user !== undefined && user !== null && typeof user === "object" && Object.hasOwn(user, field));
      };

      const computeWrites = () => (available ? plan() : []);

      // render-time display state; save() recomputes at click time
      const writes = computeWrites();
      const dirty = writes === null || writes.length > 0;
      const invalid = writes === null;
      const blocked = !dirty || invalid || saving;

      const save = async () => {
        // recompute from the latest committed render, and guard double-clicks
        const freshWrites = computeWrites();
        if (freshWrites === null || freshWrites.length === 0 || saving) return;
        setSaving(true);
        setFailed(false);
        let landed = true;
        for (const write of freshWrites) landed = (await write.run()) && landed;
        if (landed) setDrafts({});
        setSaving(false);
        setFailed(!landed);
      };

      const renderField = (field, first) => {
        const spec = specOf(field);
        const state = fieldState(field);
        const rowStyle = { ...styles.field, ...(first ? {} : styles.fieldBorder) };
        const control = spec.kind === "bool"
          ? react_jsx_runtime.jsx("input", {
              type: "checkbox",
              style: styles.checkbox,
              checked: state.text === "true",
              disabled: !writable,
              onChange: () => edit(field, state.text === "true" ? "false" : "true")
            }, field)
          : react_jsx_runtime.jsx("input", {
              id: `dsh-memory-${field}`,
              className: "dshm-input",
              style: { ...styles.input, ...(state.invalid ? styles.inputInvalid : {}) },
              type: "text",
              ...(spec.kind === "number" ? { inputMode: "numeric" } : {}),
              ...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {}),
              ...(state.invalid ? { "aria-invalid": true } : {}),
              value: state.text,
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
                state.overridden ? react_jsx_runtime.jsxs("span", {
                  style: styles.badges,
                  children: [
                    react_jsx_runtime.jsx("span", { style: styles.badge, children: t("overridden") }),
                    react_jsx_runtime.jsx("button", { type: "button", className: "dshm-reset", style: styles.reset, disabled: !writable, onClick: () => resetField(field), children: t("reset") })
                  ]
                }) : null
              ]
            }),
            control,
            react_jsx_runtime.jsx("p", { style: state.invalid ? styles.invalidText : styles.hint, children: t(state.invalid ? "invalid" : spec.hint) })
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
              loading ? react_jsx_runtime.jsx("p", { style: styles.readOnly, role: "status", children: t("loading") }) : null,
              !loading && !available ? react_jsx_runtime.jsx("p", { style: styles.readOnly, role: "status", children: t("readOnly") }) : null,
              available && !writable ? react_jsx_runtime.jsx("p", { style: styles.readOnly, role: "status", children: t("readOnly") }) : null,
              available ? FIELDS.map((field, index) => renderField(field, index === 0)) : null,
              available ? react_jsx_runtime.jsxs("div", {
                style: styles.footer,
                children: [
                  failed ? react_jsx_runtime.jsx("p", { style: styles.failed, role: "status", children: t("saveFailed") }) : null,
                  react_jsx_runtime.jsx("button", { type: "button", style: styles.discardBtn, disabled: !dirty || saving, onClick: discard, children: t("discard") }),
                  react_jsx_runtime.jsx("button", {
                    type: "button",
                    style: { ...styles.saveBtn, ...(blocked ? styles.disabled : {}) },
                    disabled: blocked,
                    onClick: save,
                    children: t(saving ? "saving" : "save")
                  })
                ]
              }) : null
            ]
          }) : null
        ]
      });
      }

      // renderCard end
    }

    /**
     * Mount the plugin-configuration card for the dsh-memory namespace.
     *
     * The data channel is the official client settings scope bound to our
     * namespace on THIS plugin's lifecycle (bind() attaches its disposer to
     * the caller's fiber). Reads ride the shared describe mirror; writes go
     * out revision-fenced through api.settings.mutate.
     * @param ctx - the browser plugin context (slots, settingsScope).
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
      const scope = ctx.settingsScope.bind({ namespace: "dsh-memory" });
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        key: "dsh-memory",
        id: "dsh-memory",
        order: 30,
        inject: () => ({ scope })
      }, MemoryCard));
    }

    exports.inject = ["slots", "settingsScope"];
    exports.apply = apply;
    return module.exports;
  }
});
