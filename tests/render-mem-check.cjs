// dsh-memory 渲染级验证：桩掉 react/jsx-runtime 与浏览器插件环境
// （slots/settingsScope），加载 client/bundle.js 的 factory，捕获 MemoryCard，
// 用桩 props 直接调用组件跑完整渲染体 + 渲染两次（含 longtermAppend bool 字段）。
// 强制步骤（见 AGENTS.md）：改动 client bundle 后必须做渲染级验证——
// node --check 拦不住渲染期 ReferenceError，且槽位渲染器会静默吞掉异常致卡片隐身。
// 用法：从 dsh-memory 根运行：node tests\render-mem-check.cjs
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "client", "bundle.js"), "utf8");

// --- react / jsx-runtime 桩 -------------------------------------------------
let callLog = [];
const stateStore = new Map();
let stateSeq = 0;
const reactStub = {
  useState: (init) => {
    const id = stateSeq++;
    if (!stateStore.has(id)) stateStore.set(id, typeof init === "function" ? init() : init);
    const set = (v) => stateStore.set(id, typeof v === "function" ? v(stateStore.get(id)) : v);
    return [stateStore.get(id), set];
  },
  useEffect: () => undefined,
  useRef: (v) => ({ current: v }),
  // 2026-09-01: 语言切换响应（<html lang> MutationObserver + store version）——
  // 桩直接返回快照（渲染期读一次），不模拟真正的 re-render 循环
  useSyncExternalStore: (_subscribe, get) => get(),
  Fragment: function Fragment() {},
};
const jsxRuntimeStub = {
  Fragment: function Fragment() {},
  jsx: (type, props) => { callLog.push(["jsx", type, props]); return { type, props, $$dshm: "jsx" }; },
  jsxs: (type, props) => { callLog.push(["jsxs", type, props]); return { type, props, $$dshm: "jsxs" }; },
};

// --- 浏览器插件环境桩 ---------------------------------------------------------
let moduleExportsOut = null; // factory 返回值（module.exports）
let registered = null; // { entry, component } 从 slots.inject 捕获
const scopeStub = {
  getSnapshot: () => ({
    status: "ready",
    value: { memoryRoot: "", searchLimit: 2, embeddingBaseUrl: "", embeddingModel: "bge-m3", autoMemory: true, longtermAppend: true },
    base: { memoryRoot: "", searchLimit: 2, embeddingBaseUrl: "", embeddingModel: "bge-m3", autoMemory: true, longtermAppend: true },
    user: {},
    writable: true,
  }),
  subscribe: () => () => undefined,
  set: async () => undefined,
  unset: async () => undefined,
};
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (def) => { moduleExportsOut = def.factory(requireStub); },
    },
  },
  console,
  // 2026-09-01: bundle 的 locale 判定层（<html lang> 权威 + MutationObserver
  // 监听）在沙箱里也需要有实体，否则渲染路径与真实环境不一致
  document: {
    documentElement: { lang: "zh-CN" },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, appendChild() {} }),
    head: { appendChild() {} },
  },
  MutationObserver: function (callback) { this.callback = callback; },
};
class MutationObserverStub {
  constructor(callback) { this.callback = callback; }
  observe() {}
  disconnect() {}
}
sandbox.MutationObserver = MutationObserverStub;

function requireStub(name) {
  if (name === "react") return reactStub;
  if (name === "react/jsx-runtime") return jsxRuntimeStub;
  throw new Error("unexpected require: " + name);
}

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "bundle.js" });

// factory 已执行：module.exports 提供 apply；模拟 apply 的挂载
const moduleExports = moduleExportsOut;
if (!moduleExports || typeof moduleExports.apply !== "function") {
  console.log("FATAL: apply not exported");
  process.exit(2);
}
const ctxStub = {
  settingsScope: { bind: () => scopeStub },
  slots: {
    inject: (_key, cb) => { cb(); },
    register: (entry, component) => { registered = { entry, component }; },
  },
};
moduleExports.apply(ctxStub);

if (!registered || typeof registered.component !== "function") {
  console.log("FATAL: MemoryCard not registered through slots");
  process.exit(2);
}
const MemoryCard = registered.component;

// --- 渲染验证 ---------------------------------------------------------------
let failed = 0;
const check = (label, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + label); if (!ok) failed++; };

// MemoryCard 的第 5 个 useState 是 open（折叠态，默认 false）——在每次渲染前把
// 它预置为 true 让字段行参与渲染（折叠时只有 header）。stateSeq 逐渲染递增，
// 不能用固定索引：open 状态位 = 本次渲染将分配的第 5 个状态（stateSeq + 4）。
const renderCard = () => {
  callLog = [];
  stateStore.set(stateSeq + 4, true);
  try {
    return MemoryCard({ scope: scopeStub });
  } catch (error) {
    console.log("render threw:", error);
    return undefined;
  }
};

let out = renderCard();
check("MemoryCard 渲染无异常", !!out && typeof out === "object");

const inputs = callLog.filter(([kind, type]) => kind === "jsx" && type === "input");
check("渲染体产出 input 控件（settings 卡片字段行）", inputs.length > 0);
const checkboxes = inputs.filter(([, , props]) => props?.type === "checkbox");
// 2026-08-29: autoMemory 开关随每轮提醒一起恢复，bool 字段共 2 个
check("bool 字段渲染为 checkbox（autoMemory + longtermAppend ≥2 个）", checkboxes.length >= 2);
const rowText = callLog.map(([, , props]) => props?.children).flat(10).filter((x) => typeof x === "string").join(" ");
// 2026-09-01: 沙箱 document.documentElement.lang="zh-CN" —— 语言判定走 <html lang>
// 权威（非 navigator.language），因此此处必须渲染 zh 文案
check("字段文案为中文（判定走 <html lang>）", rowText.includes("记忆库根目录") && rowText.includes("每轮记忆提醒"));
check("字段文案存在（长期块追加返回）", rowText.includes("长期块追加返回") || rowText.includes("Append long-term block"));
// 2026-09-01: memoryRoot 是第一个字段（text 类型），恢复默认/空值显示占位默认值
const texts = inputs.filter(([, , props]) => props?.type === "text");
check("text 字段含 memoryRoot（共 4 个 text：memoryRoot/baseUrl/model + 数值类）", texts.length >= 4);
const memoryRootInput = inputs.find(([, , props]) => props?.id === "dsh-memory-memoryRoot");
check("memoryRoot 空值有占位默认（$DSH_HOME/dsh-memory），不把默认路径误存成值", memoryRootInput && memoryRootInput[2].placeholder === "$DSH_HOME/dsh-memory" && memoryRootInput[2].value === "");

// 第二次渲染（模拟文档提交后的重读路径）也不应抛异常
out = renderCard();
check("二次渲染无异常", !!out && typeof out === "object");

// --- 语言切换响应（2026-09-01）：<html lang> 变化 → 文案切换 -----------------
// 真实环境：MutationObserver 把 <html lang> 改写 bump 成 store version →
// useSyncExternalStore 通知组件 re-render → t() 现读 <html lang> 取新语言。
// 桩无法模拟 re-render 循环，此处直接改 lang 后手动重渲染，验证的是同一渲染
// 路径上的关键断言：t() 在渲染期现读 <html lang>（非模块加载时钉死）。
sandbox.document.documentElement.lang = "en-US";
out = renderCard();
const enText = callLog.map(([, , props]) => props?.children).flat(10).filter((x) => typeof x === "string").join(" ");
check("切到英文后文案为英文（t() 现读 <html lang>）", enText.includes("Memory library root") && enText.includes("Per-turn memory reminder"));
sandbox.document.documentElement.lang = "zh-CN";

console.log(failed === 0 ? "ALL RENDER OK" : `${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);