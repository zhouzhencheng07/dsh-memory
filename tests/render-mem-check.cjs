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
    value: { searchLimit: 5, embeddingBaseUrl: "", embeddingModel: "bge-m3", longtermAppend: true },
    base: { searchLimit: 5, embeddingBaseUrl: "", embeddingModel: "bge-m3", longtermAppend: true },
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
};

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

// MemoryCard 的第 5 个 useState 是 open（折叠态，默认 false）——预置为 true
// 让字段行参与渲染（折叠时只有 header）。
const renderCard = () => {
  callLog = [];
  stateStore.set(4, true);
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
// 2026-08-28: autoMemory 开关已随提醒删除，bool 字段只剩 longtermAppend
check("bool 字段渲染为 checkbox（longtermAppend）", checkboxes.length >= 1);
const rowText = callLog.map(([, , props]) => props?.children).flat(10).filter((x) => typeof x === "string").join(" ");
check("字段文案存在（长期块追加返回）", rowText.includes("长期块追加返回") || rowText.includes("Append long-term block"));

// 第二次渲染（模拟文档提交后的重读路径）也不应抛异常
out = renderCard();
check("二次渲染无异常", !!out && typeof out === "object");

console.log(failed === 0 ? "ALL RENDER OK" : `${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);