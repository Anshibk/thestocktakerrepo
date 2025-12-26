/* ============== Utils & Store ============== */
const API_BASE = (typeof window !== "undefined" && window.__API_BASE__) ? window.__API_BASE__ : "/api/v1";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = (p = "id") => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const STORAGE_KEY = "stocktaker_state_v1";
const STORAGE_VERSION = 1;
const ENTRY_DRAFT_KEYS = ["raw", "sfg", "fg"];

function sanitizeDateRangeSnapshot(range) {
  if (!range || typeof range !== "object") {
    return { from: "", to: "" };
  }
  const normalize = (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
  };
  return { from: normalize(range.from), to: normalize(range.to) };
}

function normaliseEntryDraftSnapshot(rawDraft) {
  if (!rawDraft || typeof rawDraft !== "object") return null;
  const fields = ["date", "item", "qty", "batch", "mfg", "exp", "locationId"];
  const draft = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(rawDraft, field)) continue;
    const value = rawDraft[field];
    if (value == null) continue;
    const text = typeof value === "string" ? value.trim() : String(value).trim();
    if (text) {
      draft[field] = text;
    }
  }
  return Object.keys(draft).length ? draft : null;
}

function saveState(state) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const snapshot = {
      version: STORAGE_VERSION,
      dateRange: sanitizeDateRangeSnapshot(state?.dateRange),
      entryDrafts: {},
    };
    ENTRY_DRAFT_KEYS.forEach((key) => {
      snapshot.entryDrafts[key] = normaliseEntryDraftSnapshot(state?.entryDrafts?.[key]);
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn("Failed to persist UI state", err);
  }
}

function loadState() {
  const base = seedState();
  if (typeof window === "undefined" || !window.localStorage) {
    return base;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const payload = JSON.parse(raw);
    if (!payload || payload.version !== STORAGE_VERSION) return base;
    if (payload.dateRange) {
      base.dateRange = sanitizeDateRangeSnapshot(payload.dateRange);
    }
    base.entryDrafts = { raw: null, sfg: null, fg: null };
    if (payload.entryDrafts && typeof payload.entryDrafts === "object") {
      ENTRY_DRAFT_KEYS.forEach((key) => {
        base.entryDrafts[key] = normaliseEntryDraftSnapshot(payload.entryDrafts[key]);
      });
    }
  } catch (err) {
    console.warn("Failed to load cached UI state", err);
  }
  return base;
}

/* ============== Realtime Updates ============== */
const REALTIME_ROUTES = new Set(["dashboard","raw","sfg","fg"]);
const REALTIME_HIGHLIGHT_MS = 1400;
const realtimeHighlights = new Map();
let entryStreamSocket = null;
let entryStreamBackoff = 0;
let entryStreamTimer = null;
let entryStreamShouldReconnect = false;

function isAdminRoleActive() {
  if (typeof state === "undefined" || !state) return false;
  return !!state.currentUser?.id;
}

function isRealtimeRouteActive() {
  return typeof route === "string" && REALTIME_ROUTES.has(route);
}

function getEntryStreamUrl() {
  if (typeof window === "undefined") return "";
  const basePath = API_BASE.endsWith("/") ? API_BASE.slice(0, -1) : API_BASE;
  const origin = window.location.origin;
  const initial = basePath.startsWith("http") ? new URL(basePath) : new URL(origin + basePath);
  const cleanPath = initial.pathname.replace(/\/$/, "");
  initial.pathname = `${cleanPath}/entries/stream`;
  initial.search = "";
  initial.protocol = initial.protocol === "https:" ? "wss:" : "ws:";
  return initial.toString();
}

function shouldMaintainEntryStream() {
  if (!isRealtimeRouteActive()) return false;
  if (typeof state === "undefined" || !state || state.loading) return false;
  return isAdminRoleActive();
}

function teardownEntryStream() {
  if (entryStreamTimer) {
    clearTimeout(entryStreamTimer);
    entryStreamTimer = null;
  }
  if (entryStreamSocket) {
    try {
      entryStreamSocket.close();
    } catch (err) {
      console.warn("entry stream close failed", err);
    }
    entryStreamSocket = null;
  }
  entryStreamBackoff = 0;
}

function scheduleEntryStreamReconnect() {
  if (!entryStreamShouldReconnect) return;
  entryStreamBackoff = Math.min(entryStreamBackoff + 1, 6);
  const delay = Math.min(1000 * (2 ** entryStreamBackoff), 15000);
  connectEntryStream(delay);
}

function connectEntryStream(delay) {
  const wait = typeof delay === "number" && delay > 0 ? delay : 0;
  if (entryStreamTimer) {
    clearTimeout(entryStreamTimer);
    entryStreamTimer = null;
  }
  entryStreamTimer = setTimeout(() => {
    if (!entryStreamShouldReconnect) return;
    const url = getEntryStreamUrl();
    if (!url) return;
    try {
      const socket = new WebSocket(url);
      entryStreamSocket = socket;
      socket.onopen = () => {
        entryStreamBackoff = 0;
      };
      socket.onmessage = handleEntryStreamMessage;
      socket.onerror = () => {
        socket.close();
      };
      socket.onclose = () => {
        entryStreamSocket = null;
        scheduleEntryStreamReconnect();
      };
    } catch (err) {
      console.warn("entry stream connect failed", err);
      scheduleEntryStreamReconnect();
    }
  }, wait);
}

function ensureEntryStream() {
  entryStreamShouldReconnect = shouldMaintainEntryStream();
  if (!entryStreamShouldReconnect) {
    teardownEntryStream();
    return;
  }
  if (entryStreamSocket && (entryStreamSocket.readyState === WebSocket.OPEN || entryStreamSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  connectEntryStream(0);
}

function markRealtimeHighlight(entryId) {
  if (!entryId) return;
  realtimeHighlights.set(entryId, Date.now() + REALTIME_HIGHLIGHT_MS);
  setTimeout(() => {
    const expires = realtimeHighlights.get(entryId);
    if (expires && expires <= Date.now()) {
      realtimeHighlights.delete(entryId);
      if (isRealtimeRouteActive() && typeof state !== "undefined" && !state.loading) {
        renderRoute();
      }
    }
  }, REALTIME_HIGHLIGHT_MS + 200);
}

function isRealtimeHighlight(entryId) {
  if (!entryId) return false;
  const expires = realtimeHighlights.get(entryId);
  if (!expires) return false;
  if (expires <= Date.now()) {
    realtimeHighlights.delete(entryId);
    return false;
  }
  return true;
}

function getEntryHighlightClass(entryId) {
  if (!entryId) return "";
  return isRealtimeHighlight(String(entryId)) ? " realtime-flash" : "";
}

function hasHighlightedLine(lines) {
  if (!Array.isArray(lines)) return false;
  return lines.some((line) => line && isRealtimeHighlight(line.id));
}

function getHighlightClassForLines(lines) {
  return hasHighlightedLine(lines) ? " realtime-flash" : "";
}

function formatCountDisplay(value) {
  if (value == null || Number.isNaN(value)) return '0';
  return String(Math.round(value));
}

function formatCurrencyDisplay(value) {
  if (value == null || Number.isNaN(value)) return formatINR(null);
  return formatINR(value);
}

function animateStat(el, fromValue, toValue, formatter, duration = 900) {
  if (!el) return;
  el.classList.remove('stat-counter-soft');
  void el.offsetWidth;
  el.classList.add('stat-counter-soft');
  if (toValue == null || Number.isNaN(toValue)) {
    el.textContent = formatter(toValue);
    return;
  }
  if (fromValue == null || Number.isNaN(fromValue) || fromValue === toValue) {
    el.textContent = formatter(toValue);
    return;
  }
  const start = typeof performance !== "undefined" ? performance.now() : Date.now();
  const diff = toValue - fromValue;
  const ease = (t) => {
    const clamped = Math.min(Math.max(t, 0), 1);
    return clamped < 0.5
      ? 2 * clamped * clamped
      : 1 - Math.pow(-2 * clamped + 2, 2) / 2;
  };
  function frame(now) {
    const current = typeof performance !== "undefined" ? now : Date.now();
    const elapsed = current - start;
    const progress = elapsed >= duration ? 1 : elapsed / duration;
    const value = fromValue + diff * ease(progress);
    el.textContent = formatter(value);
    if (progress < 1) {
      requestAnimationFrame(frame);
    } else {
      el.textContent = formatter(toValue);
    }
  }
  requestAnimationFrame(frame);
}

function animateDashboardCards(prevStats, nextStats) {
  if (typeof document === "undefined") return;
  document.querySelectorAll('[data-dashboard-card]').forEach((card) => {
    const key = card.getAttribute('data-dashboard-card');
    const prev = prevStats && prevStats[key] ? prevStats[key] : null;
    const next = nextStats && nextStats[key] ? nextStats[key] : null;
    if (!next) return;
    animateStat(card.querySelector('[data-stat="categories"]'), prev ? prev.categories : null, next.categories, formatCountDisplay);
    animateStat(card.querySelector('[data-stat="items"]'), prev ? prev.items : null, next.items, formatCountDisplay);
    animateStat(card.querySelector('[data-stat="counted"]'), prev ? prev.counted : null, next.counted, formatCountDisplay);
    animateStat(card.querySelector('[data-stat="value"]'), prev ? prev.value : null, next.value, formatCurrencyDisplay);
    card.classList.remove('dashboard-card-glow');
    void card.offsetWidth;
    card.classList.add('dashboard-card-glow');
    setTimeout(() => card.classList.remove('dashboard-card-glow'), 900);
  });
}

function applyRealtimeEntry(payload) {
  if (typeof state === "undefined" || !state) return;
  const normalized = normaliseEntryFromApi(payload);
  if (!normalized || !normalized.id) return;
  if (!Array.isArray(state.lines)) {
    state.lines = [];
  }
  const idx = state.lines.findIndex((line) => line && line.id === normalized.id);
  if (idx > -1) {
    state.lines[idx] = normalized;
  } else {
    state.lines.push(normalized);
  }
  markRealtimeHighlight(normalized.id);
  triggerRealtimeRender();
}

function applyRealtimeDeletion(payload) {
  if (typeof state === "undefined" || !state) return;
  const entryId = payload && payload.id ? String(payload.id) : "";
  if (!entryId || !Array.isArray(state.lines)) return;
  const idx = state.lines.findIndex((line) => line && line.id === entryId);
  if (idx > -1) {
    state.lines.splice(idx, 1);
    realtimeHighlights.delete(entryId);
    triggerRealtimeRender();
  }
}

function triggerRealtimeRender() {
  if (!isRealtimeRouteActive()) return;
  if (typeof state === "undefined" || state.loading) return;
  renderRoute();
}

function handleEntryStreamMessage(event) {
  if (!event || typeof event.data !== "string") return;
  let payload;
  try {
    payload = JSON.parse(event.data);
  } catch (err) {
    console.warn("entry stream payload parse failed", err);
    return;
  }
  if (!payload || typeof payload.type !== "string") return;
  if (payload.type === "entry.created" || payload.type === "entry.updated") {
    applyRealtimeEntry(payload.payload || {});
  } else if (payload.type === "entry.deleted") {
    applyRealtimeDeletion(payload.payload || {});
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    entryStreamShouldReconnect = false;
    teardownEntryStream();
  });
}

const H = (s) => String(s)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const slug = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_");

function captureScrollPositions() {
  if (typeof document === "undefined") return {};
  const snapshot = {};
  $$("[data-scroll-key]").forEach((el) => {
    const key = el.getAttribute("data-scroll-key");
    if (key) snapshot[key] = el.scrollTop;
  });
  if (typeof window !== "undefined") {
    snapshot.__window = window.scrollY || 0;
  }
  return snapshot;
}

function restoreScrollPositions(snapshot) {
  if (!snapshot || typeof document === "undefined") return;
  requestAnimationFrame(() => {
    $$("[data-scroll-key]").forEach((el) => {
      const key = el.getAttribute("data-scroll-key");
      if (key && Object.prototype.hasOwnProperty.call(snapshot, key)) {
        el.scrollTop = snapshot[key] || 0;
      }
    });
    if (typeof window !== "undefined" && Object.prototype.hasOwnProperty.call(snapshot, "__window")) {
      window.scrollTo(0, snapshot.__window || 0);
    }
  });
}

async function apiRequest(path, { method = "GET", body, headers = {}, expectJson = true } = {}) {
  const init = {
    method,
    headers: { ...headers },
    credentials: "same-origin",
  };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers["Content-Type"] = init.headers["Content-Type"] || "application/json";
  }
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const payload = await response.json();
      if (payload && payload.detail) {
        message = typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail);
      }
    } catch (err) {
      try {
        const text_payload = await response.text();
        if (text_payload) message = text_payload;
      } catch {}
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204 || !expectJson) return null;
  const text_payload = await response.text();
  if (!text_payload) return null;
  try {
    return JSON.parse(text_payload);
  } catch {
    return null;
  }
}

const api = {
  get: (path) => apiRequest(path),
  post: (path, body, options = {}) => apiRequest(path, { method: "POST", body, ...options }),
  put: (path, body, options = {}) => apiRequest(path, { method: "PUT", body, ...options }),
  delete: (path, body, options = {}) => apiRequest(path, { method: "DELETE", body, ...options }),
};

/* ============== Domain constants ============== */
const G_RAW = "Raw Materials";
const G_SEMI = "Semi Finished Goods";
const G_FG = "Finished Goods";
const CORE_GROUP_NAMES = [G_FG, G_RAW, G_SEMI];

/* ============== UI scratch ============== */
const ui = {
  dashboardStats: {},
  manageTab: "categories",
  editItemId: { manage_sub: "", manage_loc: "", manage_metric: "" },
  itemPickerCleanups: {},
  dateRangeModalOpen: false,
  dateRangeDraft: { from: "", to: "" },
};
let dateModalKeyHandler = null;
let dateModalScrollLock = null;
const ICONS = { edit: "✎", trash: "🗑", confirm: "✓" };
const ROUTE_PATHS = {
  dashboard: "/dashboard",
  add: "/add-item",
  raw: "/raw-materials",
  sfg: "/semi-finished",
  fg: "/finished-goods",
  manage: "/manage-data",
  users: "/users",
};

function deepClone(value){
  if(typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepGet(obj, path){
  if(!obj || !path) return undefined;
  return path.split(".").reduce((acc,key)=>{
    if(acc == null) return undefined;
    return acc[key];
  }, obj);
}

function deepSet(obj, path, value){
  if(!obj || !path) return;
  const parts = path.split(".");
  let ref = obj;
  while(parts.length > 1){
    const key = parts.shift();
    if(typeof ref[key] !== "object" || ref[key] === null){
      ref[key] = {};
    }
    ref = ref[key];
  }
  ref[parts[0]] = value;
}

/* ============== Seed ============== */
function seedState() {
  return {
    version: 3,
    loading: true,
    error: "",
    sessions: [],
    activeSessionId: "",
    currentUserId: "",
    currentUser: null,
    permissions: {},
    items: [],
    itemById: new Map(),
    cats: {},
    categoryGroups: [],
    subcategories: [],
    categoryMeta: {
      groupNameToId: new Map(),
      groupIdToName: new Map(),
      subNameToId: new Map(),
      subIdToName: new Map(),
      subIdToGroupId: new Map(),
    },
    locations: [],
    locationById: new Map(),
    lines: [],
    entryPaging: {
      raw: defaultEntryPagingMeta(),
      sfg: defaultEntryPagingMeta(),
      fg: defaultEntryPagingMeta(),
    },
    metrics: [],
    metricEntities: [],
    entrySticky: {
      raw: { item: "", locationId: "" },
      sfg: { item: "", locationId: "" },
      fg: { item: "", locationId: "" },
    },
    roles: [],
    users: [],
    dateRange: { from: "", to: "" },
    entryDrafts: { raw: null, sfg: null, fg: null },
  };
}

function ensureEntryDrafts() {
  if (typeof state === "undefined") return;
  if (!state.entryDrafts || typeof state.entryDrafts !== "object") {
    state.entryDrafts = { raw: null, sfg: null, fg: null };
    return;
  }
  ENTRY_DRAFT_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(state.entryDrafts, key)) {
      state.entryDrafts[key] = null;
    } else if (state.entryDrafts[key] && typeof state.entryDrafts[key] !== "object") {
      state.entryDrafts[key] = null;
    }
  });
}

function getEntryDraft(sectionKey) {
  if (typeof state === "undefined") return null;
  ensureEntryDrafts();
  const draft = state.entryDrafts?.[sectionKey];
  return draft && typeof draft === "object" ? draft : null;
}

function setEntryDraftValue(sectionKey, field, value) {
  if (typeof state === "undefined") return;
  if (!ENTRY_DRAFT_KEYS.includes(sectionKey)) return;
  ensureEntryDrafts();
  const current = state.entryDrafts[sectionKey] && typeof state.entryDrafts[sectionKey] === "object" ? { ...state.entryDrafts[sectionKey] } : {};
  const text = value == null ? "" : String(value);
  const trimmed = text.trim();
  if (trimmed) {
    current[field] = trimmed;
  } else {
    delete current[field];
  }
  state.entryDrafts[sectionKey] = Object.keys(current).length ? current : null;
  saveState(state);
}

function clearEntryDraft(sectionKey) {
  if (typeof state === "undefined") return;
  if (!ENTRY_DRAFT_KEYS.includes(sectionKey)) return;
  ensureEntryDrafts();
  if (state.entryDrafts[sectionKey] !== null) {
    state.entryDrafts[sectionKey] = null;
    saveState(state);
  }
}

/* ============== Helpers ============== */
function formatINR(n){
  if(n==null) return "—";
  const x=Math.round((n+Number.EPSILON)*100)/100;
  const p=x.toFixed(2).split(".");
  let s=p[0], last3=s.slice(-3), other=s.slice(0,-3);
  const g=other.replace(/\B(?=(\d{2})+(?!\d))/g,",");
  return "₹" + (other ? g + "," : "") + last3 + (p[1] === "00" ? "" : "." + p[1]);
}
const qtyFormatter=new Intl.NumberFormat('en-IN',{minimumFractionDigits:0,maximumFractionDigits:2});
function formatQtyWithUnit(qty,unit){
  if(qty==null) return "";
  const num=Number(qty);
  const base=Number.isFinite(num)?qtyFormatter.format(num):H(String(qty));
  return unit?`${base} ${H(unit)}`:base;
}
function formatDateForDisplay(value){
  if(!value) return "";
  const parts=String(value).split("-");
  if(parts.length!==3) return "";
  const [y,m,d]=parts;
  if(!/^\d{4}$/.test(y)||!/^\d{2}$/.test(m)||!/^\d{2}$/.test(d)) return "";
  return `${d} / ${m} / ${y}`;
}
function sanitizeMonthYearInput(raw){
  if(typeof raw!=="string") raw=String(raw||"");
  let digits="";
  let hasSep=false;
  let sepChar="";
  for(const char of raw){
    if(/\d/.test(char)){
      if(digits.length<6){
        digits+=char;
      }
    }else if(/[.\/-]/.test(char)){
      if(!hasSep && digits.length>0){
        hasSep=true;
        sepChar=char;
      }
    }
  }
  if(!hasSep) return digits;
  const leftLen = digits.length>4 ? Math.max(1,digits.length-4) : Math.max(1,digits.length-2);
  const left = digits.slice(0,leftLen);
  const right = digits.slice(leftLen);
  return right?`${left}${sepChar}${right}`:left;
}
function parseMonthYear(raw){
  if(!raw) return null;
  const digits=String(raw).replace(/\D/g,"").slice(0,6);
  if(digits.length<3) return null;
  let monthDigits;
  let yearDigits;
  if(digits.length<=4){
    monthDigits=digits.slice(0,Math.max(1,digits.length-2));
    yearDigits=digits.slice(-2);
    if(!yearDigits) return null;
    const month=Number(monthDigits);
    const year=2000+Number(yearDigits);
    if(!Number.isInteger(month)||month<1||month>12) return null;
    return {month,year};
  }
  monthDigits=digits.slice(0,Math.max(1,digits.length-4));
  yearDigits=digits.slice(-4);
  const month=Number(monthDigits);
  const year=Number(yearDigits);
  if(!Number.isInteger(month)||month<1||month>12) return null;
  if(!Number.isInteger(year)||year<1000) return null;
  return {month,year};
}
function formatMonthYear(raw){
  const parsed=parseMonthYear(raw);
  if(!parsed) return "";
  const mm=String(parsed.month).padStart(2,"0");
  const yyyy=String(parsed.year).padStart(4,"0");
  return `${mm}/${yyyy}`;
}
function attachMonthYearFormatter(input){
  if(!input) return;
  input.addEventListener('input',()=>{
    const caretStart=input.selectionStart;
    const caretEnd=input.selectionEnd;
    const sanitized=sanitizeMonthYearInput(input.value||"");
    if(input.value!==sanitized){
      input.value=sanitized;
      if(typeof caretStart==='number'&&typeof caretEnd==='number'){
        const pos=Math.min(sanitized.length,caretEnd);
        requestAnimationFrame(()=>input.setSelectionRange(pos,pos));
      }
    }
  });
  input.addEventListener('blur',()=>{
    input.value=formatMonthYear(input.value||"");
  });
}
function deriveEntryDateValue(value){
  if(!value) return "";
  const trimmed=String(value).trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return "";
  return trimmed;
}
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value){
  return UUID_PATTERN.test(String(value||""));
}
function sanitizeFilename(name){
  const raw=String(name||"export.xlsx").trim();
  const lastDot=raw.lastIndexOf('.');
  let base=lastDot>0?raw.slice(0,lastDot):raw;
  let ext=lastDot>0?raw.slice(lastDot+1):"xlsx";
  base=slug(base)||"export";
  ext=ext.replace(/[^a-z0-9]/gi,"")||"xlsx";
  return `${base}.${ext}`;
}
function resolveDownloadFilename(disposition,fallback){
  if(disposition){
    const utfMatch=disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if(utfMatch){
      try{ return sanitizeFilename(decodeURIComponent(utfMatch[1])); }catch{}
    }
    const simpleMatch=disposition.match(/filename="?([^";]+)"?/i);
    if(simpleMatch){
      return sanitizeFilename(simpleMatch[1]);
    }
  }
  return sanitizeFilename(fallback);
}
async function downloadExcelFile(url,fallbackName){
  const res=await fetch(url,{
    headers:{'Accept':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}
  });
  if(!res.ok) throw new Error(`Export failed with status ${res.status}`);
  const blob=await res.blob();
  const filename=resolveDownloadFilename(res.headers.get('Content-Disposition'),fallbackName);
  const blobUrl=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=blobUrl;
  link.download=filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(blobUrl);
}
function evaluateQtyInput(raw){
  const s=String(raw??"").trim();
  if(!s) return NaN;
  if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return NaN;
  const num=Number(s);
  return Number.isFinite(num)?num:NaN;
}
function enforceUppercaseInput(el){
  if(!el) return;
  const restoreCaret=(start,end)=>{
    if(start==null||end==null) return;
    const setter=()=>el.setSelectionRange(start,end);
    if(typeof requestAnimationFrame==="function") requestAnimationFrame(setter);
    else setTimeout(setter,0);
  };
  const syncValue=()=>{ el.value=String(el.value||"").toUpperCase(); };
  el.addEventListener('input',()=>{
    const start=el.selectionStart;
    const end=el.selectionEnd;
    const upper=String(el.value||"").toUpperCase();
    if(el.value!==upper){
      el.value=upper;
      restoreCaret(start,end);
    }
  });
  el.addEventListener('blur',syncValue);
  syncValue();
}

function rebuildCategoryLookups(groups, subs){
  const meta=state.categoryMeta || (state.categoryMeta={
    groupNameToId:new Map(),
    groupIdToName:new Map(),
    subNameToId:new Map(),
    subIdToName:new Map(),
    subIdToGroupId:new Map(),
  });
  meta.groupNameToId=new Map();
  meta.groupIdToName=new Map();
  meta.subNameToId=new Map();
  meta.subIdToName=new Map();
  meta.subIdToGroupId=new Map();
  state.categoryGroups = Array.isArray(groups) ? groups.map(g=>({
    id:String(g?.id||"") || uid('group'),
    name:String(g?.name||"").trim() || "Unnamed",
  })).sort((a,b)=>a.name.localeCompare(b.name)) : [];
  state.subcategories = Array.isArray(subs) ? subs.map(s=>({
    id:String(s?.id||"") || uid('sub'),
    name:String(s?.name||"").trim() || "Unnamed",
    group_id:String(s?.group_id||"") || "",
  })).sort((a,b)=>a.name.localeCompare(b.name)) : [];
  const cats={};
  state.categoryGroups.forEach(group=>{
    meta.groupNameToId.set(group.name,group.id);
    meta.groupIdToName.set(group.id,group.name);
    cats[group.name]=[];
  });
  state.subcategories.forEach(sub=>{
    meta.subNameToId.set(sub.name,sub.id);
    meta.subIdToName.set(sub.id,sub.name);
    meta.subIdToGroupId.set(sub.id,sub.group_id);
    const groupName=meta.groupIdToName.get(sub.group_id);
    if(groupName){
      (cats[groupName] ||= []).push(sub.name);
    }
  });
  Object.keys(cats).forEach(name=>cats[name].sort((a,b)=>a.localeCompare(b)));
  state.cats=cats;
  syncEntriesWithCategoryLookups();
}

function rebuildItemLookup(){
  const items=Array.isArray(state.items)?state.items:[];
  state.itemById=new Map();
  items.forEach(item=>{
    if(item && item.id){
      state.itemById.set(String(item.id), item);
    }
  });
}

function rebuildLocationLookup(){
  const locations=Array.isArray(state.locations)?state.locations:[];
  state.locationById=new Map();
  locations.forEach(loc=>{
    if(loc && loc.id){
      state.locationById.set(String(loc.id), loc);
    }
  });
}

function lookupItemById(id){
  if(!id) return null;
  const key=String(id);
  if(state.itemById instanceof Map && state.itemById.has(key)){
    return state.itemById.get(key);
  }
  if(Array.isArray(state.items)){
    return state.items.find(item=>item?.id===key) || null;
  }
  return null;
}

function lookupLocationById(id){
  if(!id) return null;
  const key=String(id);
  if(state.locationById instanceof Map && state.locationById.has(key)){
    return state.locationById.get(key);
  }
  if(Array.isArray(state.locations)){
    return state.locations.find(loc=>loc?.id===key) || null;
  }
  return null;
}

function syncEntriesWithItemLookups(){
  if(!Array.isArray(state.lines)) return;
  let changed=false;
  const updated=state.lines.map(line=>{
    const item=lookupItemById(line.itemId);
    if(!item) return line;
    const newUnit=item.unit?String(item.unit):line.unit;
    const newCategoryId=item.categoryId||null;
    const newCategoryLabel=item.category || (newCategoryId?getCategoryNameById(newCategoryId)||getGroupNameForCategoryId(newCategoryId):line.categoryLabel);
    const newGroupLabel=item.groupName || (newCategoryId?getGroupNameForCategoryId(newCategoryId):line.groupLabel);
    const needsUpdate=line.itemName!==item.name || line.unit!==newUnit || line.categoryId!==newCategoryId || line.categoryLabel!==newCategoryLabel || line.groupLabel!==newGroupLabel;
    if(!needsUpdate) return line;
    changed=true;
    return {
      ...line,
      itemName:item.name,
      unit:newUnit,
      categoryId:newCategoryId,
      categoryLabel:newCategoryLabel,
      groupLabel:newGroupLabel,
    };
  });
  if(changed){
    state.lines=updated;
  }
}

function syncEntriesWithLocationLookups(){
  if(!Array.isArray(state.lines)) return;
  let changed=false;
  const updated=state.lines.map(line=>{
    if(!line.locationId) return line;
    const location=lookupLocationById(line.locationId);
    if(!location) return line;
    const name=location.name || line.locationName;
    if(line.locationName===name) return line;
    changed=true;
    return { ...line, locationName:name };
  });
  if(changed){
    state.lines=updated;
  }
}

function syncEntriesWithCategoryLookups(){
  if(!Array.isArray(state.lines)) return;
  let changed=false;
  const updated=state.lines.map(line=>{
    if(!line.categoryId) return line;
    const label=getCategoryNameById(line.categoryId) || line.categoryLabel;
    const groupLabel=getGroupNameForCategoryId(line.categoryId) || line.groupLabel;
    if(line.categoryLabel===label && line.groupLabel===groupLabel) return line;
    changed=true;
    return { ...line, categoryLabel:label, groupLabel };
  });
  if(changed){
    state.lines=updated;
  }
}

function applyItemToEntries(item){
  if(!item || !item.id) return;
  const key=String(item.id);
  const updated=state.lines.map(line=>{
    if(line.itemId!==key) return line;
    const newCategoryId=item.categoryId||null;
    const newCategoryLabel=item.category || (newCategoryId?getCategoryNameById(newCategoryId)||getGroupNameForCategoryId(newCategoryId):line.categoryLabel);
    const newGroupLabel=item.groupName || (newCategoryId?getGroupNameForCategoryId(newCategoryId):line.groupLabel);
    return {
      ...line,
      itemName:item.name,
      unit:item.unit?String(item.unit):line.unit,
      categoryId:newCategoryId,
      categoryLabel:newCategoryLabel,
      groupLabel:newGroupLabel,
    };
  });
  state.lines=updated;
}

function removeEntriesByItemIds(ids){
  if(!Array.isArray(ids) || !ids.length) return;
  const lookup=new Set(ids.map(id=>String(id)));
  state.lines=state.lines.filter(line=>!lookup.has(line.itemId));
}

function applyLocationToEntries(location){
  if(!location || !location.id) return;
  const key=String(location.id);
  const updated=state.lines.map(line=>{
    if(line.locationId!==key) return line;
    return { ...line, locationName:location.name };
  });
  state.lines=updated;
}

function applyCategoryUpdateToEntries(categoryId){
  if(!categoryId) return;
  const key=String(categoryId);
  const label=getCategoryNameById(key) || getGroupNameForCategoryId(key) || "";
  const groupLabel=getGroupNameForCategoryId(key) || "";
  const updated=state.lines.map(line=>{
    if(line.categoryId!==key) return line;
    return {
      ...line,
      categoryLabel:label || line.categoryLabel,
      groupLabel:groupLabel || line.groupLabel,
    };
  });
  state.lines=updated;
}

function getGroupNameForCategoryId(categoryId){
  if(!categoryId) return "";
  const meta=state.categoryMeta;
  if(!meta) return "";
  const groupId=meta.subIdToGroupId?.get(categoryId) || meta.subIdToGroupId?.get(String(categoryId));
  if(!groupId) return "";
  return meta.groupIdToName?.get(groupId) || meta.groupIdToName?.get(String(groupId)) || "";
}

function getCategoryNameById(categoryId){
  if(!categoryId) return "";
  const meta=state.categoryMeta;
  if(!meta) return "";
  return meta.subIdToName?.get(categoryId) || meta.subIdToName?.get(String(categoryId)) || "";
}

function normaliseItemFromApi(raw){
  if(!raw) return null;
  const id=String(raw.id||"");
  const unit=raw.unit==null?"":String(raw.unit).trim();
  const priceRaw=raw.price;
  const price=priceRaw==null?null:Number(priceRaw);
  const categoryId=raw.category_id?String(raw.category_id):"";
  const categoryName=categoryId?getCategoryNameById(categoryId):"";
  const groupName=categoryId?getGroupNameForCategoryId(categoryId):"";
  const label=categoryName || groupName || "";
  return {
    id,
    name:String(raw.name||"").trim(),
    nameLower:String(raw.name||"").trim().toLowerCase(),
    category:label,
    categoryId:categoryId||null,
    groupName:groupName||"",
    unit,
    price:price==null||Number.isNaN(price)?null:price,
  };
}

function normaliseEntryFromApi(entry){
  if(!entry) return null;
  const type=String(entry.type||"").toUpperCase();
  const categoryId=entry.category_id?String(entry.category_id):"";
  const categoryLabel=entry.category_name || getCategoryNameById(categoryId) || getGroupNameForCategoryId(categoryId) || "";
  const groupLabel=getGroupNameForCategoryId(categoryId);
  const itemId=entry.item_id?String(entry.item_id):"";
  const item=lookupItemById(itemId);
  const itemName=entry.item_name || item?.name || "";
  const locationId=entry.warehouse_id?String(entry.warehouse_id):"";
  const location=lookupLocationById(locationId);
  const locationName=entry.warehouse_name || location?.name || "";
  const price=entry.price_at_entry==null?null:Number(entry.price_at_entry);
  const createdRaw=entry.entry_date || entry.created_at || "";
  const userObj = entry.user || {};
  const createdDate=typeof createdRaw==="string"?createdRaw.slice(0,10):"";
  return {
    id:String(entry.id||""),
    sessionId: String(entry.session_id||""),
    itemId,
    itemName,
    categoryId: categoryId||null,
    categoryLabel,
    groupLabel,
    unit: entry.unit==null?"":String(entry.unit),
    qty: Number(entry.qty||0),
    locationId,
    locationName,
    batch: typeof entry.batch==="string"?entry.batch.trim().toUpperCase():"",
    mfg: entry.mfg?String(entry.mfg).trim():"",
    exp: entry.exp?String(entry.exp).trim():"",
    priceAtEntry: price==null||Number.isNaN(price)?null:price,
    createdAt: entry.created_at || new Date().toISOString(),
    entryDate: createdDate,
    createdBy: (userObj && userObj.name) ? String(userObj.name) : (entry.user_name || (userObj && userObj.username) || ""),
    userId: entry.user_id?String(entry.user_id):(userObj && userObj.id ? String(userObj.id) : ""),
    type,
  };
}

function defaultEntryPagingMeta(){
  return { total:0, limit:0, offset:0, hasNext:false };
}

function normaliseEntryPagePayload(payload){
  if(Array.isArray(payload)){
    return {
      items: payload,
      meta: {
        total: payload.length,
        limit: payload.length,
        offset: 0,
        hasNext: false,
      },
    };
  }
  if(payload && typeof payload === "object"){
    const items = Array.isArray(payload.items) ? payload.items : [];
    const toNumber = (value, fallback=0) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : fallback;
    };
    const hasNextFlag =
      typeof payload.hasNext !== "undefined"
        ? payload.hasNext
        : payload.has_next;
    return {
      items,
      meta: {
        total: toNumber(payload.total, items.length),
        limit: toNumber(payload.limit, items.length),
        offset: toNumber(payload.offset, 0),
        hasNext: Boolean(hasNextFlag),
      },
    };
  }
  return { items: [], meta: defaultEntryPagingMeta() };
}

function ensureEntryPaging(){
  if(!state.entryPaging){
    state.entryPaging={
      raw: defaultEntryPagingMeta(),
      sfg: defaultEntryPagingMeta(),
      fg: defaultEntryPagingMeta(),
    };
  }
}

function replaceEntriesForType(type,payload){
  ensureEntryPaging();
  const { items, meta } = normaliseEntryPagePayload(payload);
  const upper=String(type||"").toUpperCase();
  const lower=String(type||"").toLowerCase();
  const keep=state.lines.filter(line=>line?.type!==upper);
  const normalized=items.map(normaliseEntryFromApi).filter(Boolean);
  state.lines=keep.concat(normalized);
  if(lower){
    state.entryPaging[lower]={...defaultEntryPagingMeta(), ...meta};
  }
}

async function refreshEntries(type){
  const lower=String(type||"").toLowerCase();
  const payload=await api.get(`/entries/?type=${encodeURIComponent(lower)}`);
  replaceEntriesForType(type,payload);
}

async function refreshItems(){
  const payload=await api.get('/items/');
  state.items=Array.isArray(payload)?payload.map(normaliseItemFromApi).filter(Boolean):[];
  rebuildItemLookup();
  syncEntriesWithItemLookups();
}

async function refreshCategoryData(){
  const [groups, subs] = await Promise.all([
    api.get('/categories/groups'),
    api.get('/categories/subs'),
  ]);
  rebuildCategoryLookups(groups||[], subs||[]);
}

async function refreshAllEntries(){
  await Promise.all([
    refreshEntries('raw'),
    refreshEntries('sfg'),
    refreshEntries('fg'),
  ]);
}

async function deleteEntriesForItem(itemId){
  if(!itemId) return;
  const idStr=String(itemId);
  const related=state.lines.filter(line=>line.itemId===idStr);
  const ids = related.map((entry)=>entry?.id).filter(Boolean);
  if(!ids.length) return;
  await api.delete('/entries/bulk', { entry_ids: ids });
}

async function refreshLocations(){
  const payload = await api.get('/warehouses/');
  state.locations = Array.isArray(payload)
    ? payload.map(loc=>({ id:String(loc?.id||""), name:String(loc?.name||"").trim()||"Unnamed" }))
    : [];
  rebuildLocationLookup();
  syncEntriesWithLocationLookups();
}

async function refreshMetrics(){
  const payload = await api.get('/metrics/');
  state.metricEntities = Array.isArray(payload)
    ? payload.map(metric=>({ id:String(metric?.id||""), name:String(metric?.name||"").trim() }))
    : [];
  state.metrics = state.metricEntities.map(m=>m.name).filter(Boolean);
}

function normalizeScopeValue(value,fallback='OWN'){
  const raw = typeof value === "string" ? value : value && value.value;
  const normalized = (raw || fallback).toString().toUpperCase();
  return normalized === "ORG" ? "ORG" : "OWN";
}

function scopeToBackend(value){
  return value === "ORG" ? "org" : "own";
}

function ensureRoleMeta(role){
  if(!role.meta) role.meta={};
  if(typeof role.meta.can_manage_users !== "boolean"){
    role.meta.can_manage_users = !!deepGet(role,"pv.users");
  }
  if(typeof role.meta.can_manage_roles !== "boolean"){
    role.meta.can_manage_roles = !!deepGet(role,"pv.users");
  }
  if(typeof role.meta.can_view_dashboard_cards !== "boolean"){
    role.meta.can_view_dashboard_cards = true;
  }
  if(typeof role.meta.can_open_dashboard_modal !== "boolean"){
    role.meta.can_open_dashboard_modal = true;
  }
  role.meta.isAdmin = false;
  if(!role.sc || typeof role.sc !== "object"){
    role.sc={dashboard:'OWN',addItem:'OWN',raw:'OWN',sfg:'OWN',fg:'OWN'};
  }else{
    ['dashboard','addItem','raw','sfg','fg'].forEach((key)=>{
      role.sc[key]=normalizeScopeValue(role.sc[key]);
    });
  }
  return role;
}

function mapRoleFromApi(role){
  if(!role) return null;
  const result={
    id: role.id ? String(role.id) : "",
    name: String(role.name||"").trim(),
    pv:{
      dashboard: !!role.can_view_dashboard,
      addItem: !!role.can_view_add_item,
      raw: !!role.can_view_raw,
      sfg: !!role.can_view_sfg,
      fg: !!role.can_view_fg,
      manageData: !!role.can_view_manage_data,
      users: !!role.can_view_users,
    },
    ei:{
      exportData: false,
      exportWithMaster: !!role.can_export_dashboard_summary,
      exportValuated: !!role.can_export_dashboard_entries,
      importData: !!role.can_import_master_data,
    },
    act:{
      add:{
        addItem: !!role.can_import_master_data,
        raw: !!role.can_add_entry_raw,
        sfg: !!role.can_add_entry_sfg,
        fg: !!role.can_add_entry_fg,
      },
      bulk:{
        addItem: !!role.can_bulk_edit_delete_add_item,
        raw: !!role.can_bulk_edit_delete_raw,
        sfg: !!role.can_bulk_edit_delete_sfg,
        fg: !!role.can_bulk_edit_delete_fg,
      },
      edit:{
        addItem: !!role.can_edit_add_item,
        raw: !!role.can_edit_entry_raw,
        sfg: !!role.can_edit_entry_sfg,
        fg: !!role.can_edit_entry_fg,
      },
    },
    sc:{
      dashboard: normalizeScopeValue(role.dashboard_scope),
      addItem: normalizeScopeValue(role.add_item_scope ?? role.dashboard_scope),
      raw: normalizeScopeValue(role.raw_scope ?? role.entry_scope),
      sfg: normalizeScopeValue(role.sfg_scope ?? role.entry_scope),
      fg: normalizeScopeValue(role.fg_scope ?? role.entry_scope),
    },
    meta:{
      can_manage_users: !!role.can_manage_users,
      can_manage_roles: !!role.can_manage_roles,
      can_delete_users: !!role.can_delete_users,
      can_delete_roles: !!role.can_delete_roles,
      can_view_dashboard_cards: role.can_view_dashboard_cards !== undefined ? !!role.can_view_dashboard_cards : true,
      can_open_dashboard_modal: role.can_open_dashboard_modal !== undefined ? !!role.can_open_dashboard_modal : true,
      isAdmin: false,
    },
  };
  result.ei.exportData = result.ei.exportWithMaster || result.ei.exportValuated;
  if(result.act?.add){
    result.act.add.addItem = !!result.act.add.addItem;
  }
  result.ei.importData = !!result.act.add.addItem;
  ensureRoleMeta(result);
  return result;
}

function createBlankRole(name){
  const role={
    id:"",
    tempId:`temp-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
    name:String(name||"New Role"),
    pv:{dashboard:false,addItem:false,raw:false,sfg:false,fg:false,manageData:false,users:false},
    ei:{exportData:false,exportWithMaster:false,exportValuated:false,importData:false},
    act:{
      add:{addItem:false,raw:false,sfg:false,fg:false},
      bulk:{addItem:false,raw:false,sfg:false,fg:false},
      edit:{addItem:false,raw:false,sfg:false,fg:false},
    },
    sc:{dashboard:'OWN',addItem:'OWN',raw:'OWN',sfg:'OWN',fg:'OWN'},
    meta:{
      can_manage_users:false,
      can_manage_roles:false,
      can_delete_users:false,
      can_delete_roles:false,
      can_view_dashboard_cards:true,
      can_open_dashboard_modal:true,
      isAdmin:false,
    },
  };
  return ensureRoleMeta(role);
}

function mapRoleToPayload(role){
  const payload={
    name: String(role.name||"").trim(),
    can_view_dashboard: !!deepGet(role,'pv.dashboard'),
    can_view_add_item: !!deepGet(role,'pv.addItem'),
    can_view_raw: !!deepGet(role,'pv.raw'),
    can_view_sfg: !!deepGet(role,'pv.sfg'),
    can_view_fg: !!deepGet(role,'pv.fg'),
    can_view_manage_data: !!deepGet(role,'pv.manageData'),
    can_view_users: !!deepGet(role,'pv.users'),
    can_manage_users: role.meta?.can_manage_users ?? !!deepGet(role,'pv.users'),
    can_manage_roles: role.meta?.can_manage_roles ?? !!deepGet(role,'pv.users'),
    can_delete_users: role.meta?.can_delete_users ?? false,
    can_delete_roles: role.meta?.can_delete_roles ?? false,
    can_import_master_data: !!deepGet(role,'act.add.addItem'),
    can_add_entry_raw: !!deepGet(role,'act.add.raw'),
    can_add_entry_sfg: !!deepGet(role,'act.add.sfg'),
    can_add_entry_fg: !!deepGet(role,'act.add.fg'),
    can_edit_entry_raw: !!deepGet(role,'act.edit.raw'),
    can_edit_entry_sfg: !!deepGet(role,'act.edit.sfg'),
    can_edit_entry_fg: !!deepGet(role,'act.edit.fg'),
    can_edit_add_item: !!deepGet(role,'act.edit.addItem'),
    can_bulk_edit_delete_add_item: !!deepGet(role,'act.bulk.addItem'),
    can_bulk_edit_delete_raw: !!deepGet(role,'act.bulk.raw'),
    can_bulk_edit_delete_sfg: !!deepGet(role,'act.bulk.sfg'),
    can_bulk_edit_delete_fg: !!deepGet(role,'act.bulk.fg'),
    can_export_dashboard_summary: !!deepGet(role,'ei.exportData') && !!deepGet(role,'ei.exportWithMaster'),
    can_export_dashboard_entries: !!deepGet(role,'ei.exportData') && !!deepGet(role,'ei.exportValuated'),
    can_view_dashboard_cards: role.meta?.can_view_dashboard_cards !== undefined ? !!role.meta.can_view_dashboard_cards : true,
    can_open_dashboard_modal: role.meta?.can_open_dashboard_modal !== undefined ? !!role.meta.can_open_dashboard_modal : true,
  };
  if(!deepGet(role,'ei.exportData')){
    payload.can_export_dashboard_summary = false;
    payload.can_export_dashboard_entries = false;
  }
  if(!payload.can_view_users){
    payload.can_manage_users = false;
    payload.can_manage_roles = false;
  }
  payload.can_edit_manage_data = payload.can_view_manage_data;
  // Scope settings apply to all roles now, not just admin
  const scDashboard = normalizeScopeValue(deepGet(role,'sc.dashboard'));
  const scAddItem = normalizeScopeValue(deepGet(role,'sc.addItem'));
  const scRaw = normalizeScopeValue(deepGet(role,'sc.raw'));
  const scSfg = normalizeScopeValue(deepGet(role,'sc.sfg'));
  const scFg = normalizeScopeValue(deepGet(role,'sc.fg'));

  payload.dashboard_scope = scopeToBackend(scDashboard);
  payload.add_item_scope = scopeToBackend(scAddItem);
  payload.raw_scope = scopeToBackend(scRaw);
  payload.sfg_scope = scopeToBackend(scSfg);
  payload.fg_scope = scopeToBackend(scFg);
  payload.entry_scope = (scRaw === 'ORG' && scSfg === 'ORG' && scFg === 'ORG') ? 'org' : 'own';
  return payload;
}

function uniqueRoleName(base){
  const trimmed=String(base||"Role").trim()||"Role";
  const taken=new Set((state.roles||[]).map(r=>String(r.name||"").toLowerCase()));
  if(usersUi.roleDraft && !usersUi.roleDraft.id){
    taken.add(String(usersUi.roleDraft.name||"").toLowerCase());
  }
  let candidate=trimmed;
  let index=2;
  while(taken.has(candidate.toLowerCase())){
    candidate=`${trimmed} ${index++}`;
  }
  return candidate;
}

function roleKey(role){
  if(!role) return "";
  return role.id || role.tempId || "";
}

function syncRoleSelection(){
  if(usersUi.roleDraft && !usersUi.roleDraft.id && usersUi.roleDirty){
    return;
  }
  if(usersUi.selectedRoleKey){
    const current=state.roles.find(r=>r.id===usersUi.selectedRoleKey);
    if(current){
      usersUi.roleOriginal=deepClone(current);
      usersUi.roleDraft=deepClone(current);
      ensureRoleMeta(usersUi.roleDraft);
      usersUi.roleDirty=false;
      return;
    }
  }
  if(state.roles.length){
    const first=state.roles[0];
    usersUi.selectedRoleKey=first.id;
    usersUi.roleOriginal=deepClone(first);
    usersUi.roleDraft=deepClone(first);
    ensureRoleMeta(usersUi.roleDraft);
    usersUi.roleDirty=false;
  }else{
    usersUi.selectedRoleKey="";
    usersUi.roleOriginal=null;
    usersUi.roleDraft=null;
    usersUi.roleDirty=false;
  }
}

function mapUserFromApi(user){
  if(!user) return null;
  const role=user.role||{};
  return {
    id:String(user.id||""),
    username:String(user.username||"").trim(),
    email:String(user.email||"").trim(),
    name:String(user.name||"").trim(),
    roleId:role.id?String(role.id):"",
    roleName:String(role.name||"").trim()||"—",
    isActive: !!user.is_active,
    googleLinked: !!user.google_linked,
    invitationToken: String(user.invitation_token||"").trim(),
    invitedAt: user.invited_at ? new Date(user.invited_at) : null,
  };
}

async function refreshRoles(){
  const payload = await api.get('/roles/');
  state.roles = Array.isArray(payload)?payload.map(mapRoleFromApi).filter(Boolean):[];
  if(!usersUi.roleDirty){
    syncRoleSelection();
  }
}

async function refreshUsers(){
  const payload = await api.get('/users/');
  state.users = Array.isArray(payload)?payload.map(mapUserFromApi).filter(Boolean):[];
}

/* ============== Users & Roles Page ============== */
function openUserModal(userId) {
  usersUi.userModalOpen = true;
  usersUi.editUserId = userId ? String(userId) : "";
  renderUsersPage();
}

function closeUserModal() {
  usersUi.userModalOpen = false;
  usersUi.editUserId = "";
  renderUsersPage();
}

function openRolesModal() {
  if (!state.permissions?.can_manage_roles) return;
  if (!usersUi.roleDraft || (usersUi.roleDraft.id && !usersUi.roleDirty)) {
    syncRoleSelection();
  } else if (usersUi.roleDraft) {
    ensureRoleMeta(usersUi.roleDraft);
  }
  usersUi.rolesModalOpen = true;
  usersUi.roleTab = usersUi.roleTab || "visibility";
  renderUsersPage();
}

async function closeRolesModal() {
  if (usersUi.roleDirty) {
    const ok = await confirmDialog("Discard unsaved changes?");
    if (!ok) return;
    if (usersUi.roleDraft && !usersUi.roleDraft.id) {
      usersUi.roleDraft = null;
      usersUi.roleOriginal = null;
      usersUi.roleDirty = false;
      usersUi.selectedRoleKey = state.roles[0]?.id || "";
      if (usersUi.selectedRoleKey) {
        syncRoleSelection();
      }
    } else if (usersUi.roleOriginal) {
      usersUi.roleDraft = deepClone(usersUi.roleOriginal);
      ensureRoleMeta(usersUi.roleDraft);
      usersUi.roleDirty = false;
    }
  }
  usersUi.rolesModalOpen = false;
  renderUsersPage();
}

function createRoleDraft() {
  if (!state.permissions?.can_manage_roles) return;
  promptDialog("Enter role name", "").then((name) => {
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast("Role name is required.");
      return;
    }
    const unique = uniqueRoleName(trimmed);
    const blank = createBlankRole(unique);
    usersUi.roleOriginal = deepClone(blank);
    usersUi.roleDraft = blank;
    usersUi.selectedRoleKey = blank.tempId;
    usersUi.roleDirty = true;
    usersUi.rolesModalOpen = true;
    usersUi.roleTab = "visibility";
    renderUsersPage();
  });
}

function renameRoleDraft() {
  if (!usersUi.roleDraft) return;
  const current = usersUi.roleDraft.name || "";
  promptDialog("New role name", current).then((name) => {
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === current) return;
    const unique = uniqueRoleName(trimmed);
    usersUi.roleDraft.name = unique;
    ensureRoleMeta(usersUi.roleDraft);
    usersUi.roleDirty = true;
    renderUsersPage();
  });
}

function duplicateRoleDraft() {
  if (!usersUi.roleDraft) return;
  const baseName = usersUi.roleDraft.name || "Role";
  const copy = deepClone(usersUi.roleDraft);
  copy.id = "";
  copy.tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  copy.name = uniqueRoleName(`${baseName} Copy`);
  ensureRoleMeta(copy);
  usersUi.roleOriginal = deepClone(copy);
  usersUi.roleDraft = copy;
  usersUi.selectedRoleKey = copy.tempId;
  usersUi.roleDirty = true;
  renderUsersPage();
}

async function deleteRoleDraft() {
  if (!usersUi.roleDraft) return;
  if (!usersUi.roleDraft.id) {
    usersUi.roleDraft = null;
    usersUi.roleOriginal = null;
    usersUi.roleDirty = false;
    usersUi.selectedRoleKey = state.roles[0]?.id || "";
    if (usersUi.selectedRoleKey) {
      syncRoleSelection();
    } else {
      renderUsersPage();
    }
    renderUsersPage();
    return;
  }
  const ok = await confirmDialog("Delete this role?");
  if (!ok) return;
  try {
    await api.delete(`/roles/${encodeURIComponent(usersUi.roleDraft.id)}`);
    toast("Role deleted.");
    usersUi.roleDraft = null;
    usersUi.roleOriginal = null;
    usersUi.roleDirty = false;
    usersUi.selectedRoleKey = "";
    await refreshRoles();
    syncRoleSelection();
    renderUsersPage();
  } catch (err) {
    toast(err?.message || "Failed to delete role");
  }
}

async function saveRoleDraft() {
  if (!usersUi.roleDraft) return;
  const payload = mapRoleToPayload(usersUi.roleDraft);
  if (!payload.name) {
    toast("Role name is required.");
    return;
  }
  try {
    let response;
    if (usersUi.roleDraft.id) {
      response = await api.put(`/roles/${encodeURIComponent(usersUi.roleDraft.id)}`, payload);
    } else {
      response = await api.post("/roles/", payload);
    }
    const normalized = mapRoleFromApi(response);
    await refreshRoles();
    if (normalized) {
      usersUi.selectedRoleKey = normalized.id || "";
      usersUi.roleOriginal = deepClone(normalized);
      usersUi.roleDraft = deepClone(normalized);
      ensureRoleMeta(usersUi.roleDraft);
    } else {
      syncRoleSelection();
    }
    usersUi.roleDirty = false;
    toast("Role saved.");
    renderUsersPage();
  } catch (err) {
    toast(err?.message || "Failed to save role");
  }
}

function discardRoleDraft() {
  if (!usersUi.roleDraft) {
    renderUsersPage();
    return;
  }
  if (!usersUi.roleDraft.id) {
    usersUi.roleDraft = null;
    usersUi.roleOriginal = null;
    usersUi.roleDirty = false;
    if (state.roles.length) {
      usersUi.selectedRoleKey = state.roles[0].id;
      syncRoleSelection();
    } else {
      renderUsersPage();
    }
    renderUsersPage();
    return;
  }
  if (usersUi.roleOriginal) {
    usersUi.roleDraft = deepClone(usersUi.roleOriginal);
    ensureRoleMeta(usersUi.roleDraft);
  }
  usersUi.roleDirty = false;
  usersUi.roleTab = "visibility";
  renderUsersPage();
}

function updateRoleField(path, value) {
  if (!usersUi.roleDraft) return;
  const adminLocked = false; // No admin role concept anymore
  if (adminLocked) {
    if (!path || !String(path).startsWith('sc.')) {
      return;
    }
  }
  if (path === "pv.users") {
    deepSet(usersUi.roleDraft, path, !!value);
    usersUi.roleDraft.meta.can_manage_users = !!value;
    usersUi.roleDraft.meta.can_manage_roles = !!value;
  } else if (path === "ei.exportData") {
    deepSet(usersUi.roleDraft, path, !!value);
    if (!value) {
      usersUi.roleDraft.ei.exportWithMaster = false;
      usersUi.roleDraft.ei.exportValuated = false;
    } else if (!usersUi.roleDraft.ei.exportWithMaster && !usersUi.roleDraft.ei.exportValuated) {
      usersUi.roleDraft.ei.exportValuated = true;
    }
  } else if (path === "act.add.addItem") {
    deepSet(usersUi.roleDraft, path, !!value);
    if (!usersUi.roleDraft.ei) usersUi.roleDraft.ei = {};
    usersUi.roleDraft.ei.importData = !!value;
  } else if (path === "ei.importData") {
    deepSet(usersUi.roleDraft, path, !!value);
    if (!usersUi.roleDraft.act) usersUi.roleDraft.act = {};
    if (!usersUi.roleDraft.act.add) usersUi.roleDraft.act.add = {};
    usersUi.roleDraft.act.add.addItem = !!value;
  } else {
    deepSet(usersUi.roleDraft, path, value);
  }
  ensureRoleMeta(usersUi.roleDraft);
  usersUi.roleDirty = true;
  renderUsersPage();
}

function setRoleScope(scopeKey, value) {
  if (!usersUi.roleDraft) return;
  if (!state.permissions?.can_manage_roles) return;
  if (!usersUi.roleDraft.sc) usersUi.roleDraft.sc = {};
  usersUi.roleDraft.sc[scopeKey] = value === "ORG" ? "ORG" : "OWN";
  usersUi.roleDirty = true;
  renderUsersPage();
}

function renderUsersPage() {
  const page = $("#page");
  if (!page) return;
  const scrollSnapshot = captureScrollPositions();
  const canViewUsers = !!state.permissions?.can_view_users;
  if (!canViewUsers) {
    page.innerHTML = `<div class="users-page px-4 py-10"><div class="max-w-xl mx-auto card p-6 text-center"><h2 class="text-lg font-semibold text-slate-800 mb-2">Access restricted</h2><p class="text-sm text-slate-500">You do not have permission to view the Users area.</p></div></div>`;
    return;
  }
  injectUsersPageStyles();
  const canManageUsers = !!state.permissions?.can_manage_users;
  const canManageRoles = !!state.permissions?.can_manage_roles;
  if (!usersUi.roleDraft && state.roles.length) {
    syncRoleSelection();
  }
  if (usersUi.rolesModalOpen) {
    if (!usersUi.roleDraft || (usersUi.roleDraft.id && !usersUi.roleDirty)) {
      syncRoleSelection();
    }
    if (usersUi.roleDraft) {
      ensureRoleMeta(usersUi.roleDraft);
    }
  }
  const buildInviteLink = (token) => {
    if (!token) return "";
    const origin = (typeof window !== "undefined" && window.location) ? window.location.origin.replace(/\/$/, "") : "";
    return `${origin || ""}/login?invite=${encodeURIComponent(token)}`;
  };
  const userRows = state.users.length
    ? state.users
        .map((user) => {
          const activation = canManageUsers
            ? `<label class="inline-flex items-center gap-2 cursor-pointer select-none"><input type="checkbox" data-activate="${H(user.id)}" class="h-4 w-4" ${user.isActive ? "checked" : ""}><span class="text-slate-600 text-sm">${user.isActive ? "Active" : "Inactive"}</span></label>`
            : `<span class="hint">${user.isActive ? "Active" : "Inactive"}</span>`;
          const statusPills = [];
          if (user.googleLinked) {
            statusPills.push('<span class="status-pill success">Google linked</span>');
          } else if (user.invitationToken) {
            statusPills.push('<span class="status-pill pending">Pending invite</span>');
          } else {
            statusPills.push('<span class="status-pill muted">Invite required</span>');
          }
          statusPills.push(`<span class="status-pill ${user.isActive ? 'info' : 'muted'}">${user.isActive ? 'Active' : 'Inactive'}</span>`);
          const actions = [];
          if (canManageUsers && user.invitationToken) {
            actions.push(`<button class="btn text-sm" data-copy-invite="${H(user.invitationToken)}">Copy invite link</button>`);
          }
          if (canManageUsers && user.invitationToken && !user.googleLinked) {
            actions.push(`<button class="btn text-sm" data-regenerate-invite="${H(user.id)}">Regenerate invite</button>`);
          }
          if (canManageUsers) {
            actions.push(`<button class="btn text-sm" data-edit-user="${H(user.id)}">Edit</button>`);
            actions.push(`<button class="btn btn-danger text-sm" data-del-user="${H(user.id)}" data-username="${H(user.email || user.username)}">Delete</button>`);
          }
          const actionCell = actions.length ? `<div class="user-actions">${actions.join('')}</div>` : '<span class="hint">No actions</span>';
          const rowClass = "";
          const displayName = user.name || user.username;
          const emailLine = user.email ? `<div class="user-email">${H(user.email)}</div>` : "";
          const inviteLink = user.invitationToken ? `<div class="user-invite-link">${H(buildInviteLink(user.invitationToken))}</div>` : "";
          return `<tr class="user-row${rowClass}">
      <td class="user-cell user-info-cell">
        <div class="user-name">${H(displayName)}</div>
        ${emailLine}
      </td>
      <td class="user-cell"><span class="role-pill">${H(user.roleName)}</span></td>
      <td class="user-cell"><div class="status-pills">${statusPills.join('')}</div></td>
      <td class="user-cell">${activation}</td>
      <td class="user-cell user-actions-cell">${actionCell}</td>
    </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="px-5 py-6 text-center text-sm text-slate-500">No users yet.</td></tr>`;

  const roleDraft = usersUi.roleDraft ? ensureRoleMeta(usersUi.roleDraft) : null;
  const roleList = state.roles.slice();
  if (roleDraft && !roleDraft.id && usersUi.selectedRoleKey === roleDraft.tempId) {
    roleList.push(roleDraft);
  }
  const roleListHtml = roleList.length
    ? roleList
        .map((role) => {
          ensureRoleMeta(role);
          const key = roleKey(role);
          const selected = usersUi.selectedRoleKey ? usersUi.selectedRoleKey === key : roleList[0] === role;
          const defaultLabel = '';
          const unsavedLabel = !role.id ? '<div class="mt-1 text-[11px] text-cyan-600">Unsaved</div>' : '';
          const chips = [
            role.pv?.dashboard ? '<span class="role-pill">Dashboard</span>' : '',
            role.pv?.raw ? '<span class="role-pill">Raw</span>' : '',
            role.pv?.sfg ? '<span class="role-pill">SFG</span>' : '',
            role.pv?.fg ? '<span class="role-pill">FG</span>' : '',
          ]
            .filter(Boolean)
            .join(" ");
          return `<button data-role-pick="${H(key)}" class="w-full text-left px-3 py-2 rounded-lg border ${selected ? 'border-cyan-300 bg-cyan-50 text-cyan-800' : 'border-slate-200 hover:bg-slate-50'}">
      <div class="flex items-center justify-between">
        <span class="font-medium">${H(role.name || 'Unnamed')}</span>
        ${defaultLabel}
      </div>
      <div class="mt-1 text-[12px] text-slate-500 flex flex-wrap gap-1">${chips}</div>
      ${unsavedLabel}
    </button>`;
        })
        .join("")
    : `<div class="text-sm text-slate-500">No roles yet.</div>`;

  let roleTab = usersUi.roleTab || "visibility";
  const isAdminRole = false; // No admin role concept anymore
  const adminRoleLocked = false; // All roles can be edited
  const canToggleRolePermissions = canManageRoles;
  const tabConfig = [
    ["visibility", "Page Visibility"],
    ["export", "Export/Import"],
    ["actions", "Actions"],
  ];
  if (!tabConfig.some(([key]) => key === roleTab)) {
    roleTab = "visibility";
    usersUi.roleTab = roleTab;
  }
  const checkboxDisabledAttr = canToggleRolePermissions ? "" : " disabled";
  const broadcastDisabledAttr = canManageRoles ? "" : " disabled";
  const exportDisabled = !roleDraft?.ei?.exportData;
  const wrapExportWithMasterClass = `pl-6${(!canToggleRolePermissions || exportDisabled) ? ' is-disabled' : ''}`;
  const wrapExportValuatedClass = `pl-6${(!canToggleRolePermissions || exportDisabled) ? ' is-disabled' : ''}`;
  const exportSubDisabledAttr = !canToggleRolePermissions || exportDisabled ? ' disabled' : '';
  const addUserDisabledAttr = !canManageUsers ? ' disabled' : '';
  const addUserClasses = !canManageUsers ? 'btn btn-primary opacity-50 cursor-not-allowed' : 'btn btn-primary';
  const manageRolesDisabledAttr = !canManageRoles ? ' disabled' : '';
  const manageRolesBtnClasses = !canManageRoles ? 'btn opacity-50 cursor-not-allowed' : 'btn';
  const newRoleBtnAttr = !canManageRoles ? ' disabled' : '';
  const newRoleBtnClass = !canManageRoles ? 'btn btn-primary opacity-50 cursor-not-allowed' : 'btn btn-primary';
  const roleNameLabel = roleDraft ? roleDraft.name || '—' : '—';
  const dirtyChipClass = `role-pill bg-cyan-50 border-cyan-200 text-cyan-700${usersUi.roleDirty ? '' : ' hidden'}`;
  const renameLocked = !canToggleRolePermissions || !roleDraft;
  const duplicateLocked = !canManageRoles || !roleDraft;
  const deleteLocked = !canManageRoles || !roleDraft;
  const renameBtnAttr = renameLocked ? ' disabled' : '';
  const duplicateBtnAttr = duplicateLocked ? ' disabled' : '';
  const deleteBtnAttr = deleteLocked ? ' disabled' : '';
  const renameBtnClass = renameLocked ? 'btn opacity-50 cursor-not-allowed' : 'btn';
  const duplicateBtnClass = duplicateLocked ? 'btn opacity-50 cursor-not-allowed' : 'btn';
  const deleteBtnClass = deleteLocked ? 'btn btn-danger opacity-50 cursor-not-allowed' : 'btn btn-danger';
  const saveRoleLocked = !canManageRoles || !roleDraft;
  const saveRoleBtnAttr = saveRoleLocked ? ' disabled' : '';
  const saveRoleBtnClass = saveRoleLocked ? 'btn btn-primary opacity-50 cursor-not-allowed' : 'btn btn-primary';
  const saveUserBtnAttr = !canManageUsers ? ' disabled' : '';
  const saveUserBtnClass = !canManageUsers ? 'btn btn-primary opacity-50 cursor-not-allowed' : 'btn btn-primary';

  let visibilityPanel = '';
  let exportPanel = '';
  let actionsPanel = '';
  if (roleDraft) {
    // Helper to render a visibility item with scope toggle
    const renderVisItem = (pvKey, scKey, label) => {
      const pvChecked = !!roleDraft.pv?.[pvKey];
      const scChecked = scKey ? (roleDraft.sc?.[scKey] || "OWN") === "ORG" : false;
      const scopeToggle = scKey ? `
              <div class="vis-scope-toggle${!pvChecked ? ' is-disabled' : ''}">
                <label class="scope-toggle-inline">
                  <input type="checkbox" data-broadcast="${H(scKey)}" class="scope-checkbox-sm"${scChecked ? ' checked' : ''}${!pvChecked ? ' disabled' : ''}${checkboxDisabledAttr}>
                  <span class="scope-label-sm">${scChecked ? 'All' : 'Own'}</span>
                </label>
              </div>` : '';
      return `
            <div class="vis-item${pvChecked ? ' is-active' : ''}">
              <label class="vis-item-main">
                <input data-k="pv.${pvKey}" type="checkbox" class="perm-checkbox"${pvChecked ? ' checked' : ''}${checkboxDisabledAttr}>
                <span class="perm-label">${H(label)}</span>
              </label>${scopeToggle}
            </div>`;
    };

    visibilityPanel = `
      <div class="panel ${roleTab === 'visibility' ? 'active' : ''}" data-panel="visibility">
        <div class="perm-card${canToggleRolePermissions ? '' : ' is-disabled'}">
          <div class="perm-card-header">
            <div class="perm-card-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            </div>
            <div>
              <h3 class="perm-card-title">Page Visibility</h3>
              <p class="perm-card-desc">Control which pages this role can access and data scope</p>
            </div>
          </div>
          <div class="vis-grid">
            ${renderVisItem('dashboard', 'dashboard', 'Dashboard')}
            ${renderVisItem('addItem', 'addItem', 'Master Data')}
            ${renderVisItem('raw', 'raw', 'Raw Materials')}
            ${renderVisItem('sfg', 'sfg', 'Semi Finished')}
            ${renderVisItem('fg', 'fg', 'Finished Goods')}
            <div class="vis-item-empty"></div>
            ${renderVisItem('manageData', null, 'Manage Data')}
            ${renderVisItem('users', null, 'Users')}
          </div>
          <div class="scope-hint-inline">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            <span><strong>Own:</strong> See own entries only. <strong>All:</strong> See all users' entries.</span>
          </div>
        </div>
      </div>`;
    exportPanel = `
      <div class="panel ${roleTab === 'export' ? 'active' : ''}" data-panel="export">
        <div class="perm-card${canToggleRolePermissions ? '' : ' is-disabled'}">
          <div class="perm-card-header">
            <div class="perm-card-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/></svg>
            </div>
            <div>
              <h3 class="perm-card-title">Export &amp; Import</h3>
              <p class="perm-card-desc">Data export and import capabilities</p>
            </div>
          </div>
          <div class="perm-section">
            <h4 class="perm-section-title">Export Options</h4>
            <div class="perm-list">
              <label class="perm-item-row">
                <input data-k="ei.exportData" type="checkbox" class="perm-checkbox"${roleDraft.ei?.exportData ? ' checked' : ''}${checkboxDisabledAttr}>
                <div class="perm-item-content">
                  <span class="perm-item-label">Export Data</span>
                  <span class="perm-item-hint">Allow exporting data to files</span>
                </div>
              </label>
              <div id="wrapExportWithMaster" class="perm-sub${(!canToggleRolePermissions || exportDisabled) ? ' is-disabled' : ''}">
                <label class="perm-item-row">
                  <input data-k="ei.exportWithMaster" type="checkbox" class="perm-checkbox"${roleDraft.ei?.exportWithMaster ? ' checked' : ''}${exportSubDisabledAttr}>
                  <div class="perm-item-content">
                    <span class="perm-item-label">Include master items</span>
                    <span class="perm-item-hint">Export all items even without entries</span>
                  </div>
                </label>
              </div>
              <div id="wrapExportValuated" class="perm-sub${(!canToggleRolePermissions || exportDisabled) ? ' is-disabled' : ''}">
                <label class="perm-item-row">
                  <input data-k="ei.exportValuated" type="checkbox" class="perm-checkbox"${roleDraft.ei?.exportValuated ? ' checked' : ''}${exportSubDisabledAttr}>
                  <div class="perm-item-content">
                    <span class="perm-item-label">Valuated items only</span>
                    <span class="perm-item-hint">Only items with entries in period</span>
                  </div>
                </label>
              </div>
            </div>
          </div>
          <div class="perm-section">
            <h4 class="perm-section-title">Import Options</h4>
            <div class="perm-list">
              <label class="perm-item-row">
                <input data-k="ei.importData" type="checkbox" class="perm-checkbox"${roleDraft.ei?.importData ? ' checked' : ''}${checkboxDisabledAttr}>
                <div class="perm-item-content">
                  <span class="perm-item-label">Import Data</span>
                  <span class="perm-item-hint">Allow importing data from files</span>
                </div>
              </label>
            </div>
          </div>
        </div>
      </div>`;
    const actionModules = [
      ["addItem", "Master Data"],
      ["raw", "Raw Materials"],
      ["sfg", "Semi Finished"],
      ["fg", "Finished Goods"],
    ];
    const renderActionGroup = (groupKey, title, icon) => `
          <div class="action-group">
            <div class="action-group-header">
              ${icon}
              <span>${title}</span>
            </div>
            <div class="action-group-items">
              ${actionModules
                .map(([key, label]) => {
                  const checked = !!deepGet(roleDraft, `act.${groupKey}.${key}`);
                  return `<label class="action-item"><input data-k="act.${groupKey}.${key}" type="checkbox" class="perm-checkbox"${checked ? ' checked' : ''}${checkboxDisabledAttr}><span>${H(label)}</span></label>`;
                })
                .join("")}
            </div>
          </div>`;

    actionsPanel = `
      <div class="panel ${roleTab === 'actions' ? 'active' : ''}" data-panel="actions">
        <div class="perm-card${canToggleRolePermissions ? '' : ' is-disabled'}">
          <div class="perm-card-header">
            <div class="perm-card-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75"/></svg>
            </div>
            <div>
              <h3 class="perm-card-title">Actions</h3>
              <p class="perm-card-desc">Configure available interactions for each module</p>
            </div>
          </div>
          <div class="actions-grid">
            ${renderActionGroup('add', 'Add Entries', '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M12 5v14m-7-7h14"/></svg>')}
            ${renderActionGroup('edit', 'Edit Entries', '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l2.651 2.65M18.5 2.99a2.121 2.121 0 013 3l-13 13-4 1 1-4 13-13z"/></svg>')}
            ${renderActionGroup('bulk', 'Bulk Delete', '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>')}
          </div>
        </div>
        <!-- Settings section for delete permissions -->
        <div class="perm-card mt-6${canToggleRolePermissions ? '' : ' is-disabled'}" style="margin-top: 1.5rem;">
          <div class="perm-card-header">
            <div class="perm-card-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            </div>
            <div>
              <h3 class="perm-card-title">Settings</h3>
              <p class="perm-card-desc">Configure delete permissions for users and roles</p>
            </div>
          </div>
          <div class="settings-grid">
            <div class="settings-item">
              <label class="settings-checkbox">
                <input type="checkbox" data-setting="can_delete_users" class="perm-checkbox"${roleDraft?.meta?.can_delete_users ? ' checked' : ''}${checkboxDisabledAttr}>
                <div class="settings-label">
                  <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                  <span>Can Delete Users</span>
                </div>
              </label>
              <p class="settings-hint">Allow this role to delete other users from the system</p>
            </div>
            <div class="settings-item">
              <label class="settings-checkbox">
                <input type="checkbox" data-setting="can_delete_roles" class="perm-checkbox"${roleDraft?.meta?.can_delete_roles ? ' checked' : ''}${checkboxDisabledAttr}>
                <div class="settings-label">
                  <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
                  <span>Can Delete Roles</span>
                </div>
              </label>
              <p class="settings-hint">Allow this role to delete other roles from the system</p>
            </div>
          </div>
        </div>
      </div>`;
  }

  const panelPieces = roleDraft ? [visibilityPanel, exportPanel, actionsPanel] : [];
  const rolePanels = roleDraft
    ? `<div class="flex-1 min-h-0 overflow-y-auto pr-1" data-scroll-key="roleEditorScroll">${panelPieces.join('')}</div>`
    : '<div class="flex-1 min-h-0 flex items-center justify-center text-sm text-slate-500">Select a role to view permissions.</div>';

  const tabsHtml = tabConfig
    .map(([key, label]) => `<button class="tab ${roleTab === key ? 'active' : ''}" data-tab="${key}">${H(label)}</button>`)
    .join("");

  const roleEditorContent = `
    <div class="roles-editor-header">
      <div class="roles-editor-info">
        <div class="roles-editor-name">
          <span id="roleNameChip">${H(roleNameLabel)}</span>
          <span id="dirtyChip" class="role-badge unsaved${usersUi.roleDirty ? '' : ' hidden'}">Unsaved</span>
        </div>
      </div>
      <nav class="roles-tabs" id="roleTabs">${tabsHtml}</nav>
    </div>
    <div class="roles-panels">
      ${rolePanels}
    </div>
    <footer class="roles-editor-footer">
      <button id="btnDiscardRole" class="btn btn-outline">Discard</button>
      <button id="btnSaveRole" class="${saveRoleBtnClass}"${saveRoleBtnAttr}>Save Role</button>
    </footer>
  `;

  const userModalTitle = usersUi.editUserId ? "Edit User" : "Invite User";

  page.innerHTML = `
    <div class="users-page-container">
      <header class="users-page-header">
        <div>
          <h1 class="users-page-title">Users</h1>
          <p class="users-page-subtitle">Manage users, roles, and permissions.</p>
        </div>
      </header>
      <div class="users-page-actions">
        <div class="users-page-buttons">
          <button id="btnAddUser" class="${addUserClasses}"${addUserDisabledAttr}>+ Invite User</button>
          <button id="btnManageRoles" class="${manageRolesBtnClasses}"${manageRolesDisabledAttr}>Manage Roles</button>
        </div>
        <span class="users-page-hint">Data is stored in PostgreSQL.</span>
      </div>
      <div class="users-table-card">
        <div class="users-table-header">
          <div class="users-table-title">Users</div>
          <div class="users-table-count">${state.users.length} user${state.users.length !== 1 ? 's' : ''}</div>
        </div>
        <div class="users-table-wrapper">
          <table class="users-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Activation</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="usersBody">${userRows}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div id="userModal" class="modal${usersUi.userModalOpen ? ' show' : ''}">
      <div class="mask" data-close></div>
      <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(92vw,560px)] card">
        <div class="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div id="userModalTitle" class="font-semibold">${H(userModalTitle)}</div>
          <button class="btn" data-close>Close</button>
        </div>
        <div class="p-5 space-y-4">
          <div data-field="email">
            <label class="block text-sm font-medium text-slate-700 mb-1">Gmail address</label>
            <input id="fUserEmail" type="email" class="w-full border border-slate-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-cyan-500" placeholder="user@gmail.com" />
            <p class="text-xs text-slate-500 mt-1">Invitations only support @gmail.com accounts.</p>
          </div>
          <div data-field="name">
            <label class="block text-sm font-medium text-slate-700 mb-1">Name</label>
            <input id="fUserName" class="w-full border border-slate-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-cyan-500" placeholder="Display name (required)" />
          </div>
          <div data-field="role">
            <label class="block text-sm font-medium text-slate-700 mb-1">Role</label>
            <select id="fUserRole" class="w-full border border-slate-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-cyan-500"></select>
          </div>
          <div data-field="active">
            <label class="inline-flex items-center gap-2 text-sm text-slate-700">
              <input id="fUserActive" type="checkbox" class="h-4 w-4" checked />
              <span>Active</span>
            </label>
          </div>
          <div id="inviteDetails" class="hidden text-sm text-slate-600 bg-slate-100 border border-slate-200 rounded-lg p-3">
            <div class="font-semibold mb-1">Invitation link</div>
            <div id="inviteLinkDisplay" class="break-all text-xs"></div>
            <button id="btnCopyInviteFromModal" class="btn text-xs mt-2">Copy link</button>
          </div>
        </div>
        <div class="px-5 py-4 border-t border-slate-200 flex items-center justify-end gap-2">
          <button class="btn" data-close>Cancel</button>
          <button id="btnSaveUser" class="${saveUserBtnClass}"${saveUserBtnAttr}>Save</button>
        </div>
      </div>
    </div>

    <div id="rolesModal" class="modal${usersUi.rolesModalOpen ? ' show' : ''}">
      <div class="mask" data-close></div>
      <div class="roles-modal-container">
        <header class="roles-modal-header">
          <div>
            <h2 class="roles-modal-title">Manage Roles</h2>
            <p class="roles-modal-subtitle">Configure permissions and access control</p>
          </div>
          <button class="btn-icon" data-close title="Close">
            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </header>
        <div class="roles-modal-body">
          <aside class="roles-sidebar" data-scroll-key="roleListScroll">
            <div class="roles-sidebar-header">
              <span class="roles-sidebar-title">Roles</span>
              <button id="btnNewRole" class="${newRoleBtnClass} btn-sm"${newRoleBtnAttr}>
                <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" d="M12 5v14m-7-7h14"/></svg>
                Add
              </button>
            </div>
            <div id="rolesList" class="roles-list">${roleListHtml}</div>
            <div class="roles-sidebar-actions">
              <div class="roles-actions-row">
                <button id="btnRenameRole" class="${renameBtnClass} btn-action-sm"${renameBtnAttr}>
                  <img src="/static/icons/rename.png" alt="" width="14" height="14" style="opacity:0.7;" />
                  Rename
                </button>
                <button id="btnDuplicateRole" class="${duplicateBtnClass} btn-action-sm"${duplicateBtnAttr}>
                  <img src="/static/icons/duplicate.png" alt="" width="14" height="14" style="opacity:0.7;" />
                  Duplicate
                </button>
              </div>
              <button id="btnDeleteRole" class="${deleteBtnClass} btn-action-danger"${deleteBtnAttr}>
                <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                Delete
              </button>
            </div>
          </aside>
          <section class="roles-editor">
            ${roleEditorContent}
          </section>
        </div>
      </div>
    </div>
  `;

  const addBtn = $("#btnAddUser");
  if (addBtn) {
    addBtn.onclick = canManageUsers ? () => openUserModal("") : null;
  }

  const manageBtn = $("#btnManageRoles");
  if (manageBtn) {
    manageBtn.onclick = canManageRoles ? () => openRolesModal() : null;
  }

  const copyInviteLink = async (token) => {
    const link = buildInviteLink(token);
    if (!token || !link) {
      toast("Invitation link is not available yet");
      return;
    }
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
        toast("Invitation link copied to clipboard");
      } else {
        throw new Error("clipboard unsupported");
      }
    } catch (_err) {
      copyDialog("Copy this invitation link:", link);
    }
  };

  if (canManageUsers) {
    $$("#usersBody [data-edit-user]").forEach((btn) => (btn.onclick = () => openUserModal(btn.getAttribute("data-edit-user"))));
    $$("#usersBody [data-del-user]").forEach((btn) =>
      (btn.onclick = async () => {
        const id = btn.getAttribute("data-del-user");
        const uname = btn.getAttribute("data-username") || "this user";
        const ok = await confirmDialog(`Delete ${uname}?`);
        if (!ok) return;
        try {
          btn.disabled = true;
          await api.delete(`/users/${encodeURIComponent(id)}`);
          await refreshUsers();
          renderUsersPage();
          toast("User deleted");
        } catch (err) {
          toast(err?.message || "Failed to delete user");
        } finally {
          btn.disabled = false;
        }
      })
    );
    $$("#usersBody [data-copy-invite]").forEach((btn) =>
      (btn.onclick = async () => {
        const token = btn.getAttribute("data-copy-invite");
        if (!token) {
          toast("No invitation token available");
          return;
        }
        await copyInviteLink(token);
      })
    );
    $$("#usersBody [data-regenerate-invite]").forEach((btn) =>
      (btn.onclick = async () => {
        const id = btn.getAttribute("data-regenerate-invite");
        if (!id) return;
        btn.disabled = true;
        try {
          await api.put(`/users/${encodeURIComponent(id)}`, { regenerate_invitation: true });
          await refreshUsers();
          renderUsersPage();
          toast("Invitation regenerated");
        } catch (err) {
          toast(err?.message || "Failed to regenerate invitation");
        } finally {
          btn.disabled = false;
        }
      })
    );
    $$("#usersBody [data-activate]").forEach((cb) =>
      (cb.onchange = async () => {
        const id = cb.getAttribute("data-activate");
        const next = cb.checked;
        cb.disabled = true;
        try {
          await api.put(`/users/${encodeURIComponent(id)}`, { is_active: next });
          await refreshUsers();
          renderUsersPage();
          toast(next ? "User activated" : "User deactivated");
        } catch (err) {
          cb.checked = !next;
          toast(err?.message || "Failed to update user");
        } finally {
          cb.disabled = false;
        }
      })
    );
  }

  $$("#userModal [data-close]").forEach((btn) => (btn.onclick = () => closeUserModal()));

  const saveUserBtn = $("#btnSaveUser");
  if (saveUserBtn) {
    saveUserBtn.onclick = canManageUsers
      ? async () => {
          const emailEl = $("#fUserEmail");
          const nameEl = $("#fUserName");
          const roleEl = $("#fUserRole");
          const activeEl = $("#fUserActive");
          const emailRaw = (emailEl?.value || "").trim();
          const email = emailRaw.toLowerCase();
          const name = (nameEl?.value || "").trim();
          const roleId = roleEl?.value || "";
          const isActive = activeEl ? !!activeEl.checked : true;
          if (!roleId) {
            toast("Select a role");
            return;
          }
          if (!usersUi.editUserId) {
            if (!name) {
              toast("Enter a display name");
              return;
            }
            if (!email) {
              toast("Enter a Gmail address");
              return;
            }
            if (!email.endsWith("@gmail.com")) {
              toast("Only Gmail addresses can be invited");
              return;
            }
          }
          try {
            saveUserBtn.disabled = true;
            if (usersUi.editUserId) {
              const payload = { role_id: roleId, is_active: isActive };
              if (name) {
                payload.name = name;
              }
              await api.put(`/users/${encodeURIComponent(usersUi.editUserId)}`, payload);
              toast("User updated");
            } else {
              const payload = { email, name, role_id: roleId, is_active: isActive };
              const created = await api.post("/users/", payload);
              await refreshUsers();
              if (created?.invitation_token) {
                await copyInviteLink(created.invitation_token);
              }
              toast("Invitation created");
              closeUserModal();
              return;
            }
            await refreshUsers();
            closeUserModal();
          } catch (err) {
            toast(err?.message || "Failed to save user");
          } finally {
            saveUserBtn.disabled = false;
          }
        }
      : null;
  }

  if (usersUi.userModalOpen) {
    const emailEl = $("#fUserEmail");
    const nameEl = $("#fUserName");
    const roleEl = $("#fUserRole");
    const activeEl = $("#fUserActive");
    const inviteWrap = $("#inviteDetails");
    const inviteLinkDisplay = $("#inviteLinkDisplay");
    const inviteCopyBtn = $("#btnCopyInviteFromModal");
    const editing = state.users.find((u) => u.id === usersUi.editUserId);
    const options = state.roles.map((role) => `<option value="${H(role.id)}">${H(role.name)}</option>`).join("");
    if (roleEl) {
      roleEl.innerHTML = options;
    }
    if (editing) {
      if (emailEl) {
        emailEl.value = editing.email || editing.username;
        emailEl.disabled = true;
      }
      if (nameEl) {
        nameEl.value = editing.name || "";
      }
      if (roleEl) {
        roleEl.value = editing.roleId || state.roles[0]?.id || "";
        roleEl.disabled = false;
      }
      if (activeEl) {
        activeEl.checked = !!editing.isActive;
      }
      if (editing.invitationToken) {
        inviteWrap?.classList.remove("hidden");
        if (inviteLinkDisplay) {
          inviteLinkDisplay.textContent = buildInviteLink(editing.invitationToken);
        }
        if (inviteCopyBtn) {
          inviteCopyBtn.disabled = false;
          inviteCopyBtn.onclick = () => copyInviteLink(editing.invitationToken);
        }
      } else {
        inviteWrap?.classList.add("hidden");
        if (inviteLinkDisplay) inviteLinkDisplay.textContent = "";
        if (inviteCopyBtn) inviteCopyBtn.onclick = null;
      }
      nameEl?.focus();
    } else {
      if (emailEl) {
        emailEl.disabled = false;
        emailEl.value = "";
        emailEl.focus();
      }
      if (nameEl) {
        nameEl.value = "";
      }
      if (roleEl) {
        roleEl.disabled = false;
        roleEl.value = state.roles[0]?.id || "";
      }
      if (activeEl) {
        activeEl.checked = true;
      }
      inviteWrap?.classList.add("hidden");
      if (inviteLinkDisplay) inviteLinkDisplay.textContent = "";
      if (inviteCopyBtn) inviteCopyBtn.onclick = null;
    }
  }

  if (usersUi.rolesModalOpen) {
    $$("#rolesModal [data-close]").forEach((btn) => (btn.onclick = () => {
      closeRolesModal();
    }));
    $$("#rolesModal [data-role-pick]").forEach((btn) => {
      btn.onclick = async () => {
        const key = btn.getAttribute("data-role-pick");
        if (usersUi.roleDirty) {
          const ok = await confirmDialog("Discard unsaved changes?");
          if (!ok) return;
          if (usersUi.roleDraft && !usersUi.roleDraft.id) {
            usersUi.roleDraft = null;
            usersUi.roleOriginal = null;
            usersUi.roleDirty = false;
          }
        }
        if (key) {
          const existing = state.roles.find((r) => roleKey(r) === key || r.id === key);
          if (existing) {
            usersUi.selectedRoleKey = existing.id;
            usersUi.roleOriginal = deepClone(existing);
            usersUi.roleDraft = deepClone(existing);
            ensureRoleMeta(usersUi.roleDraft);
            usersUi.roleDirty = false;
          } else if (usersUi.roleDraft && !usersUi.roleDraft.id && usersUi.roleDraft.tempId === key) {
            usersUi.selectedRoleKey = key;
          }
        }
        renderUsersPage();
      };
    });
    $$("#roleTabs .tab").forEach((tab) => {
      tab.onclick = () => {
        usersUi.roleTab = tab.getAttribute("data-tab") || "visibility";
        renderUsersPage();
      };
    });
    if (canManageRoles && roleDraft) {
      $$("#rolesModal [data-k]").forEach((input) => {
        const path = input.getAttribute("data-k");
        if (input.type === "checkbox") {
          input.checked = !!deepGet(roleDraft, path);
        }
        input.onchange = () => {
          const value = input.type === "checkbox" ? input.checked : input.value;
          updateRoleField(path, value);
        };
      });
      // Handle settings checkboxes (can_delete_users, can_delete_roles)
      $$("#rolesModal [data-setting]").forEach((input) => {
        const settingKey = input.getAttribute("data-setting");
        input.onchange = () => {
          if (!usersUi.roleDraft) return;
          if (!usersUi.roleDraft.meta) usersUi.roleDraft.meta = {};
          usersUi.roleDraft.meta[settingKey] = input.checked;
          usersUi.roleDirty = true;
          renderUsersPage();
        };
      });
      // Data scope checkboxes for all roles
      $$("#rolesModal [data-broadcast]").forEach((checkbox) => {
        checkbox.onchange = () => {
          const key = checkbox.getAttribute("data-broadcast");
          setRoleScope(key, checkbox.checked ? "ORG" : "OWN");
        };
      });
      const wrapMaster = $("#wrapExportWithMaster");
      const wrapVal = $("#wrapExportValuated");
      if (wrapMaster) {
        wrapMaster.classList.toggle("is-disabled", !roleDraft.ei?.exportData);
        const input = wrapMaster.querySelector("input");
        if (input) input.disabled = !roleDraft.ei?.exportData;
      }
      if (wrapVal) {
        wrapVal.classList.toggle("is-disabled", !roleDraft.ei?.exportData);
        const input = wrapVal.querySelector("input");
        if (input) input.disabled = !roleDraft.ei?.exportData;
      }
    }
    const btnNew = $("#btnNewRole");
    if (btnNew) btnNew.onclick = canManageRoles ? () => createRoleDraft() : null;
    const btnRename = $("#btnRenameRole");
    if (btnRename) btnRename.onclick = canManageRoles ? () => renameRoleDraft() : null;
    const btnDuplicate = $("#btnDuplicateRole");
    if (btnDuplicate) btnDuplicate.onclick = canManageRoles ? () => duplicateRoleDraft() : null;
    const btnDelete = $("#btnDeleteRole");
    if (btnDelete) btnDelete.onclick = canManageRoles ? () => deleteRoleDraft() : null;
    const btnDiscard = $("#btnDiscardRole");
    if (btnDiscard) btnDiscard.onclick = () => discardRoleDraft();
    const btnSave = $("#btnSaveRole");
    if (btnSave) btnSave.onclick = canManageRoles ? () => saveRoleDraft() : null;
  }

  restoreScrollPositions(scrollSnapshot);
}

function applyBootstrap(payload){
  if(!payload||typeof payload!=="object") return;
  const user=payload.user||{};
  state.currentUser=user;
  state.currentUserId=user.id?String(user.id):state.currentUserId;
  state.permissions = user.permissions || state.permissions || {};
  state.shareScopes = user.share_scopes || {};
  if (state.permissions) {
    state.permissions.can_edit_manage_data = !!state.permissions.can_view_manage_data;
  }
  state.sessions = Array.isArray(payload.sessions)?payload.sessions.map(s=>({
    id:String(s?.id||""),
    code:String(s?.code||"").trim(),
    name:String(s?.name||"").trim(),
  })) : [];
  if(!state.activeSessionId && state.sessions.length){
    state.activeSessionId=state.sessions[0].id;
  }
  state.locations = Array.isArray(payload.locations)?payload.locations.map(loc=>({
    id:String(loc?.id||""),
    name:String(loc?.name||"").trim()||"Unnamed",
  })):[];
  rebuildLocationLookup();
  syncEntriesWithLocationLookups();
  state.metricEntities = Array.isArray(payload.metrics)?payload.metrics.map(m=>({
    id:String(m?.id||""),
    name:String(m?.name||"").trim(),
  })):[];
  state.metrics = state.metricEntities.map(m=>m.name).filter(Boolean);
  rebuildCategoryLookups(payload.groups||[],payload.subcategories||[]);
}

async function hydrateState(){
  state.loading=true;
  state.error="";
  renderApp();
  try{
    const bootstrap=await api.get('/bootstrap/');
    applyBootstrap(bootstrap||{});
    const itemsPromise=refreshItems();
    const locationsPromise=refreshLocations();
    const metricsPromise=refreshMetrics();
    const entriesPromise=refreshAllEntries();
    await Promise.all([itemsPromise, locationsPromise, metricsPromise, entriesPromise]);
    if(state.permissions?.can_manage_roles || state.permissions?.can_manage_users){
      try{ await refreshRoles(); }
      catch(err){ console.error(err); state.roles=[]; }
    }else{
      state.roles=[];
    }
    if(state.permissions?.can_manage_users){
      try{ await refreshUsers(); }
      catch(err){ console.error(err); state.users=[]; }
    }else{
      state.users=[];
    }
  }catch(err){
    console.error(err);
    state.error=err?.message||'Failed to load data';
  }finally{
    state.loading=false;
    renderApp();
  }
}

function cleanupItemPicker(key){
  if(!ui.itemPickerCleanups) ui.itemPickerCleanups={};
  const clean=ui.itemPickerCleanups[key];
  if(typeof clean==='function'){
    clean();
    delete ui.itemPickerCleanups[key];
  }
}
function initItemPicker(key,container,inputEl,panelEl,items){
  cleanupItemPicker(key);
  if(!container||!inputEl||!panelEl||inputEl.readOnly){
    return;
  }
  if(!ui.itemPickerCleanups) ui.itemPickerCleanups={};

  let open=false;
  let matches=items.slice();
  let activeIndex=-1;

  const highlight=()=>{
    const buttons=panelEl.querySelectorAll('[data-idx]');
    buttons.forEach(btn=>{
      const isActive=Number(btn.getAttribute('data-idx'))===activeIndex;
      btn.classList.toggle('bg-cyan-50',isActive);
      btn.classList.toggle('text-cyan-700',isActive);
    });
  };
  const ensureActiveVisible=()=>{
    if(activeIndex<0) return;
    const activeBtn=panelEl.querySelector(`[data-idx="${activeIndex}"]`);
    if(!activeBtn) return;
    const top=activeBtn.offsetTop;
    const bottom=top+activeBtn.offsetHeight;
    const viewTop=panelEl.scrollTop;
    const viewBottom=viewTop+panelEl.clientHeight;
    if(top<viewTop) panelEl.scrollTop=top;
    else if(bottom>viewBottom) panelEl.scrollTop=bottom-panelEl.clientHeight;
  };
  const openPanel=()=>{
    if(open) return;
    panelEl.classList.remove('hidden');
    inputEl.setAttribute('aria-expanded','true');
    open=true;
  };
  const closePanel=()=>{
    if(!open) return;
    panelEl.classList.add('hidden');
    inputEl.setAttribute('aria-expanded','false');
    open=false;
    activeIndex=-1;
    highlight();
  };
  const select=(idx)=>{
    const choice=matches[idx];
    if(!choice) return;
    inputEl.value=choice.name;
    closePanel();
    inputEl.focus();
    inputEl.dispatchEvent(new Event('change',{bubbles:true}));
  };
  const render=(term)=>{
    const q=String(term||"").trim().toLowerCase();
    matches=q?items.filter(it=>{
      const nameLower=(it.nameLower||it.name||"").toLowerCase();
      const catLower=String(it.category||"").toLowerCase();
      return nameLower.includes(q)||catLower.includes(q);
    }):items.slice();
    if(matches.length){
      panelEl.innerHTML=matches.map((it,idx)=>{
        const meta=[it.category,it.unit].filter(Boolean).join(' • ');
        return `
          <button type="button" data-idx="${idx}" class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-slate-700 hover:bg-cyan-50">
            <span class="flex-1 truncate">${H(it.name)}</span>
            ${meta?`<span class="text-xs text-slate-400 flex-shrink-0">${H(meta)}</span>`:""}
          </button>
        `;
      }).join("");
    }else{
      panelEl.innerHTML='<div class="px-3 py-2 text-sm text-slate-400">No matching items</div>';
    }
    activeIndex=-1;
    highlight();
    panelEl.scrollTop=0;
    panelEl.querySelectorAll('[data-idx]').forEach(btn=>{
      btn.onmousedown=e=>{
        e.preventDefault();
        const idx=Number(btn.getAttribute('data-idx'));
        select(idx);
      };
    });
  };
  const moveActive=(delta)=>{
    if(!matches.length) return;
    if(!open) openPanel();
    if(activeIndex===-1){
      activeIndex=delta>0?0:matches.length-1;
    }else{
      activeIndex=(activeIndex+delta+matches.length)%matches.length;
    }
    highlight();
    ensureActiveVisible();
  };

  render(inputEl.value);

  const docHandler=(evt)=>{
    if(!container.contains(evt.target)) closePanel();
  };
  document.addEventListener('pointerdown',docHandler);
  ui.itemPickerCleanups[key]=()=>{
    document.removeEventListener('pointerdown',docHandler);
    closePanel();
  };

  inputEl.setAttribute('role','combobox');
  inputEl.setAttribute('aria-autocomplete','list');
  inputEl.setAttribute('aria-expanded','false');

  inputEl.addEventListener('focus',()=>{
    render(inputEl.value);
    openPanel();
    inputEl.select();
  });
  inputEl.addEventListener('click',()=>{
    render(inputEl.value);
    openPanel();
  });
  inputEl.addEventListener('input',()=>{
    render(inputEl.value);
    openPanel();
  });
  inputEl.addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'){
      e.preventDefault();
      moveActive(1);
    }else if(e.key==='ArrowUp'){
      e.preventDefault();
      moveActive(-1);
    }else if(e.key==='Enter'){
      if(open&&activeIndex>-1){
        e.preventDefault();
        select(activeIndex);
      }
    }else if(e.key==='Escape'){
      if(open){
        e.preventDefault();
        closePanel();
      }
    }
  });
}
function enforceNumericInput(el){
  if(!el) return;
  el.addEventListener('keydown',e=>{
    if(e.ctrlKey||e.metaKey||e.altKey) return;
    const allowed=['Backspace','Tab','Enter','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Delete','Home','End'];
    if(allowed.includes(e.key)) return;
    if(e.key==='.'){
      if(el.value.includes('.')){
        e.preventDefault();
      }
      return;
    }
    if(e.key>='0'&&e.key<='9') return;
    e.preventDefault();
  });
  el.addEventListener('input',()=>{
    const raw=String(el.value||'');
    let cleaned='';
    let dotUsed=false;
    for(const ch of raw){
      if(ch>='0'&&ch<='9') cleaned+=ch;
      else if(ch==='.'&&!dotUsed){
        cleaned+='.';
        dotUsed=true;
      }
    }
    if(raw!==cleaned) el.value=cleaned;
  });
}
function currentUser(state){
  if(state.currentUser && typeof state.currentUser==='object'){
    const user=state.currentUser;
    return {
      name:String(user.name||user.username||'User'),
      role:String(user.role||'User'),
      username:String(user.username||user.name||'user'),
    };
  }
  return {name:'User',role:'User',username:'user'};
}
function groupsList(state){return Object.keys(state.cats||{}).sort((a,b)=>a.localeCompare(b));}
function subcatsOf(state,g){return (state.cats?.[g]||[]).slice().sort((a,b)=>a.localeCompare(b));}
function groupOfLabel(state,label){
  if(!label) return "";
  if(state.cats?.[label]) return label;                     // label is a group
  for(const g of Object.keys(state.cats||{})){ if((state.cats[g]||[]).includes(label)) return g; } // label is a sub
  return "";
}
/* ============== Global UI flags ============== */
let state=loadState();
ensureEntryDrafts();
if(typeof window!=="undefined"){
  window.state=state;
  window.saveState=saveState;
}
let route="dashboard";
if(typeof window!=="undefined"){
  const currentPath=window.location?.pathname||"";
  const match=Object.entries(ROUTE_PATHS).find(([,path])=>path===currentPath);
  if(match) route=match[0];
}
let sidebarOpen=true;

const addPanel={ add:false, raw:false, sfg:false, fg:false };
const editItemId={ add:"", raw:"", sfg:"", fg:"" };
const bulkMode={ add:false, raw:false, sfg:false, fg:false };
const bulkSelected={ add:new Set(), raw:new Set(), sfg:new Set(), fg:new Set() };
const flt={
  add:{group:"all",sub:""},
  raw:{sub:"",loc:""},
  sfg:{sub:"",loc:""},
  fg:{sub:"",loc:""},
  dash:{group:"all",sub:"",loc:""}
};
const usersUi={
  userModalOpen:false,
  editUserId:"",
  rolesModalOpen:false,
  selectedRoleKey:"",
  roleDraft:null,
  roleOriginal:null,
  roleDirty:false,
  roleTab:"visibility",
};

const USERS_PAGE_STYLE_ID = "users-page-styles";
const USERS_PAGE_STYLE_CSS = `:root{ --accent:#06b6d4; }
html,body{ height:100%; background:#f8fafc; }
body{ font-family:'Inter',system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:#0f172a; }
.card{ background:#fff; border:1px solid #e2e8f0; border-radius:1rem; box-shadow:0 1px 2px rgba(0,0,0,.04); }
.btn{ display:inline-flex; align-items:center; gap:.5rem; border:1px solid #cbd5e1; border-radius:.6rem; padding:.5rem .9rem; background:#fff; font-weight:600; color:#334155; }
.btn:hover{ background:#f1f5f9; }
.btn-primary{ background:var(--accent); color:#fff; border-color:transparent; }
.btn-primary:hover{ filter:brightness(.95); }
.btn-danger{ background:#ef4444; color:#fff; border-color:transparent; }
.btn-danger:hover{ filter:brightness(.95); }
.modal{ position:fixed; inset:0; display:none; z-index:50; }
.modal.show{ display:block; }
.mask{ position:absolute; inset:0; background:rgba(15,23,42,.55); backdrop-filter:blur(2px); }
.role-pill{ font-size:.7rem; padding:.15rem .45rem; border-radius:.8rem; background:#f1f5f9; border:1px solid #e2e8f0; }
.status-pill{ display:inline-flex; align-items:center; gap:.25rem; font-size:.7rem; font-weight:600; padding:.2rem .55rem; border-radius:.8rem; }
.status-pill.success{ background:#dcfce7; color:#166534; }
.status-pill.pending{ background:#fef3c7; color:#92400e; }
.status-pill.muted{ background:#e2e8f0; color:#475569; }
.status-pill.info{ background:#e0f2fe; color:#0369a1; }
.hint{ font-size:.78rem; color:#64748b; }
.two-col{ display:grid; grid-template-columns:260px 1fr; gap:1rem; }
@media (max-width: 980px){ .two-col{ grid-template-columns:1fr; } }
.tabs{ display:flex; gap:.25rem; padding:.25rem; background:#f1f5f9; border:1px solid #e2e8f0; border-radius:.75rem; }
.tab{ padding:.45rem .8rem; border-radius:.55rem; font-weight:600; color:#475569; }
.tab.active{ background:#fff; color:#0f172a; border:1px solid #e2e8f0; }
.panel{ display:none; }
.panel.active{ display:block; }
.is-disabled{ opacity:.45; pointer-events:none; filter:grayscale(.1); }
.section-divider{ height:1px; background:#e2e8f0; margin:14px 0; }
.sub-divider{ height:1px; background:#e2e8f0; margin:10px 0; }
.seg3{
  display:grid; gap:0;
  border:1px solid #e2e8f0; border-radius:.75rem; overflow:hidden;
  grid-template-columns:1fr;
}
.seg3 > label{ display:flex; align-items:center; gap:.6rem; padding:.75rem 1rem; }
.seg3 > label + label{ border-top:1px solid #e2e8f0; }
@media (min-width: 640px){
  .seg3{ grid-template-columns:repeat(3,minmax(0,1fr)); }
  .seg3 > label{ border-top:0; }
  .seg3 > label + label{ border-top:0; border-left:1px solid #e2e8f0; }
}
.segAuto{
  border:1px solid #e2e8f0; border-radius:.75rem; overflow:hidden;
}
@media (min-width:640px){
  .segAuto{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }
  .segAuto > label{ padding:.65rem .9rem; }
  .segAuto > label{ border-top:1px solid #e2e8f0; }
  .segAuto > label:nth-child(-n+2){ border-top:0; }
  .segAuto > label:nth-child(2n){ border-left:1px solid #e2e8f0; }
}
@media (max-width:639px){
  .segAuto > label{ display:block; padding:.65rem .9rem; }
  .segAuto > label + label{ border-top:1px solid #e2e8f0; }
}
.segRadio{
  display:flex; border:1px solid #e2e8f0; border-radius:.75rem; overflow:hidden;
}
.segRadio > label{
  flex:1; display:flex; align-items:center; justify-content:center; gap:.5rem;
  padding:.65rem .9rem;
}
.segRadio > label + label{ border-left:1px solid #e2e8f0; }
`;

function injectUsersPageStyles(){
  if(typeof document === "undefined") return;
  if(document.getElementById(USERS_PAGE_STYLE_ID)) return;
  const style=document.createElement("style");
  style.id=USERS_PAGE_STYLE_ID;
  style.textContent=USERS_PAGE_STYLE_CSS;
  document.head.appendChild(style);
}

function getDateRange(){
  const dr = state.dateRange && typeof state.dateRange === "object" ? state.dateRange : {from:"",to:""};
  const from = typeof dr.from === "string" ? dr.from.trim() : "";
  const to = typeof dr.to === "string" ? dr.to.trim() : "";
  return {
    from: from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : "",
    to: to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : "",
  };
}

function matchesDateFilter(line){
  const {from,to}=getDateRange();
  if(!from && !to) return true;
  if(!line || typeof line !== "object") return false;
  const created = typeof line.createdAt === "string" ? line.createdAt.slice(0,10) : "";
  if(!created) return false;
  if(from && created < from) return false;
  if(to && created > to) return false;
  return true;
}

function linesForActiveSession(){
  const sid=state.activeSessionId;
  const allLines=Array.isArray(state.lines)?state.lines:[];
  return allLines.filter(line=>line && line.sessionId===sid && matchesDateFilter(line));
}

function setDateRange(fromValue, toValue){
  const parse=(raw)=>{
    if(!raw) return "";
    const trimmed=String(raw).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed)?trimmed:"";
  };
  let from=parse(fromValue);
  let to=parse(toValue);
  if(from && to && from>to){
    if(fromValue){
      to=from;
    }else{
      from=to;
    }
  }
  state.dateRange={from,to};
  ui.dateRangeDraft={from,to};
  renderApp();
}

function clearDateRange(){
  ui.dateRangeDraft={from:"",to:""};
  ui.dateRangeModalOpen=false;
  setDateRange("","");
}

function openDateRangeModal(){
  const current=getDateRange();
  ui.dateRangeDraft={...current};
  ui.dateRangeModalOpen=true;
  renderApp();
}

function closeDateRangeModal(){
  ui.dateRangeModalOpen=false;
  ui.dateRangeDraft={...getDateRange()};
  renderApp();
}

function applyDateRangeModal(fromValue,toValue){
  ui.dateRangeModalOpen=false;
  setDateRange(fromValue,toValue);
}

/* ============== App Shell (push sidebar) ============== */
function renderApp(){
  const root=$("#app");
  if(!root) return;
  saveState(state);
  const cu=currentUser(state);
  const dateRange=getDateRange();
  const hasDateRange=!!(dateRange.from||dateRange.to);
  const fromDisplay= formatDateForDisplay(dateRange.from) || "[dd / mm / yyyy]";
  const toDisplay= formatDateForDisplay(dateRange.to) || "[dd / mm / yyyy]";
  const initialLoading = state.loading && !state.sessions.length && !state.items.length && !state.locations.length;
  if(initialLoading){
    root.innerHTML = `
      <div class="min-h-screen flex flex-col items-center justify-center bg-slate-50 text-slate-500">
        <div class="animate-pulse text-lg font-semibold">Loading data…</div>
      </div>`;
    return;
  }

  const errorBanner = state.error ? `<div class="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 shadow-sm">${H(state.error)}</div>` : "";
  const loadingOverlay = state.loading ? `<div class="absolute inset-0 bg-white/70 backdrop-blur-sm flex items-center justify-center text-sm text-slate-600"><span class="animate-pulse">Syncing…</span></div>` : "";

  const navConfig=[
    ["dashboard","Dashboard","can_view_dashboard"],
    ["add","Master Data","can_view_add_item"],
    ["raw","Raw Materials","can_view_raw"],
    ["sfg","Semi Finished","can_view_sfg"],
    ["fg","Finished Goods","can_view_fg"],
    ["manage","Manage Data","can_view_manage_data"],
    ["users","Users","can_view_users"],
  ];
  const availableNav=navConfig.filter(([,,perm])=>perm?!!state.permissions?.[perm]:true);
  if(!availableNav.length){
    root.innerHTML = `
      <div class="min-h-screen flex flex-col items-center justify-center bg-slate-50 text-slate-500">
        <div class="text-lg font-semibold">No pages have been assigned to your role yet.</div>
      </div>`;
    return;
  }
  if(!availableNav.some(([key])=>key===route)){
    route = availableNav[0][0];
  }
  const navHtml=availableNav.map(([k,l])=>{
    const active=route===k;
    return `<button type="button" data-nav="${H(k)}" class="nav-link px-4 py-2.5 text-sm cursor-pointer text-left ${active?'active':'text-slate-600'}">${H(l)}</button>`;
  }).join("");

  root.innerHTML=`
    <div class="app-shell ${sidebarOpen?'sidebar-open':''}">
      <aside class="sidebar">
        <div class="flex items-center gap-3 font-bold text-xl mb-6 p-3 whitespace-nowrap text-slate-800">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2L2 7V17L12 22L22 17V7L12 2Z" stroke="var(--brand-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M2 7L12 12L22 7" stroke="var(--brand-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M12 12V22" stroke="var(--brand-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>Stock Taker</span>
        </div>
        <nav class="flex flex-col gap-1 font-semibold p-3">${navHtml}</nav>
      </aside>

      <main class="content">
        ${errorBanner}
        <div class="sticky top-0 z-20 bg-white/80 backdrop-blur-sm border-b border-slate-200 px-4 flex items-center justify-between gap-4" style="height:var(--topbarH);">
          <div class="flex items-center gap-3 flex-wrap text-sm text-slate-600">
            <button id="btnSidebar" class="p-2 rounded-md hover:bg-slate-100 transition-colors" title="Toggle Sidebar">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
            </button>
            <div class="date-range-wrapper">
              <button type="button" id="openDateRange" class="date-range-display ${hasDateRange?'has-value':''}" aria-haspopup="dialog" aria-expanded="${ui.dateRangeModalOpen ? 'true' : 'false'}">
                <span class="label">FROM</span>
                <span class="value">${H(fromDisplay)}</span>
                <span class="label">TO</span>
                <span class="value">${H(toDisplay)}</span>
              </button>
            </div>
          </div>
          <div class="mx-auto">
            <span class="pill"><span class="dot"></span><span class="font-semibold">${H(cu.name)}</span></span>
          </div>
          <div class="flex items-center justify-end min-w-[90px]">
            <button id="btnLogout" class="px-3 py-1.5 text-sm font-semibold text-white bg-slate-700 hover:bg-slate-900 rounded-lg transition">Logout</button>
          </div>
        </div>

        <div id="page" class="relative p-4 md:p-8 max-w-full mx-auto w-full">${loadingOverlay}</div>
        <div id="toast" class="fixed bottom-5 right-5 hidden bg-slate-900 text-white rounded-xl px-4 py-2.5 shadow-lg z-[9999] font-semibold text-sm"></div>
        <div id="dateRangeModal" class="modal${ui.dateRangeModalOpen ? ' show' : ''}">
          <div class="mask" data-close></div>
          <div class="modal-dialog modal-dialog--sm">
            <div class="modal-header">
              <div>
                <h3 class="modal-title">Filter by date</h3>
                <p class="modal-subtitle">Choose a period to view stock entries.</p>
              </div>
              <button type="button" class="modal-close" data-close aria-label="Close">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
            </div>
            <div class="modal-body modal-body--grid">
              <div class="modal-field">
                <label for="modalDateFrom">From</label>
                <input type="date" id="modalDateFrom" value="${H((ui.dateRangeDraft?.from || getDateRange().from || ''))}" />
              </div>
              <div class="modal-field">
                <label for="modalDateTo">To</label>
                <input type="date" id="modalDateTo" value="${H((ui.dateRangeDraft?.to || getDateRange().to || ''))}" />
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="modal-btn secondary" data-close>Cancel</button>
              <button type="button" class="modal-btn secondary" id="dateRangeClear">Clear</button>
              <button type="button" class="modal-btn primary" id="dateRangeApply">Apply</button>
            </div>
          </div>
        </div>
        <div id="confirmOverlay" class="modal modal--confirm">
          <div class="mask" data-close></div>
          <div class="modal-dialog modal-dialog--sm">
            <div class="modal-header">
              <h3 class="modal-title">Please confirm</h3>
              <button type="button" class="modal-close" data-close aria-label="Close">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
            </div>
            <div class="modal-body">
              <p id="confirmMessage" class="text-sm text-slate-600 leading-relaxed"></p>
            </div>
            <div class="modal-footer">
              <button type="button" id="confirmCancel" class="modal-btn secondary">Cancel</button>
              <button type="button" id="confirmOk" class="modal-btn primary">Confirm</button>
            </div>
          </div>
        </div>
        <div id="exportOverlay" class="modal modal--export">
          <div class="mask" data-close></div>
          <div class="modal-dialog modal-dialog--md">
            <div class="modal-header">
              <div>
                <h3 class="modal-title">Export dashboard</h3>
                <p class="modal-subtitle">Do you want to include all master items?</p>
              </div>
              <button type="button" class="modal-close" data-close aria-label="Close">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
            </div>
            <form id="exportForm" class="modal-body space-y-4">
              <label class="flex items-start gap-3 p-3 border border-slate-200 rounded-xl hover:border-cyan-400 transition cursor-pointer">
                <input type="radio" name="exportMode" value="with-master" class="mt-1.5 h-4 w-4 text-cyan-600 focus:ring-cyan-500" checked>
                <span>
                  <span class="block text-sm font-semibold text-slate-900">Export with master items</span>
                  <span class="block text-xs text-slate-500 mt-1">All master items, even those without entries, with placeholder rows in the Entries sheet.</span>
                </span>
              </label>
              <label class="flex items-start gap-3 p-3 border border-slate-200 rounded-xl hover:border-cyan-400 transition cursor-pointer">
                <input type="radio" name="exportMode" value="valuated" class="mt-1.5 h-4 w-4 text-cyan-600 focus:ring-cyan-500">
                <span>
                  <span class="block text-sm font-semibold text-slate-900">Export valuated items</span>
                  <span class="block text-xs text-slate-500 mt-1">Only items that have entries in the current stock-taking period.</span>
                </span>
              </label>
              <p class="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">Scope: Uses the active stock-taking period.</p>
            </form>
            <div class="modal-footer">
              <button type="button" class="modal-btn secondary" data-close>Cancel</button>
              <button type="button" id="exportSubmit" class="modal-btn primary">Export</button>
            </div>
          </div>
        </div>
      </main>
    </div>
  `;

  $("#btnSidebar").onclick=()=>{ sidebarOpen=!sidebarOpen; renderApp(); };
  const dateTrigger=$("#openDateRange");
  if(dateTrigger) dateTrigger.onclick=()=>openDateRangeModal();
  const dateModal=$("#dateRangeModal");
  if(dateModal){
    dateModal.querySelectorAll('[data-close]').forEach(btn=>{
      btn.onclick=()=>closeDateRangeModal();
    });
    const modalFrom=$("#modalDateFrom");
    const modalTo=$("#modalDateTo");
    if(modalFrom){
      modalFrom.onchange=e=>{ ui.dateRangeDraft={...ui.dateRangeDraft, from:e.target.value||""}; };
      modalFrom.oninput=e=>{ ui.dateRangeDraft={...ui.dateRangeDraft, from:e.target.value||""}; };
      if(ui.dateRangeModalOpen) modalFrom.focus();
    }
    if(modalTo){
      modalTo.onchange=e=>{ ui.dateRangeDraft={...ui.dateRangeDraft, to:e.target.value||""}; };
      modalTo.oninput=e=>{ ui.dateRangeDraft={...ui.dateRangeDraft, to:e.target.value||""}; };
    }
    const applyBtn=$("#dateRangeApply");
    if(applyBtn){
      applyBtn.onclick=()=>{
        const from=modalFrom?modalFrom.value||"":"";
        const to=modalTo?modalTo.value||"":"";
        applyDateRangeModal(from,to);
      };
    }
    const modalClear=$("#dateRangeClear");
    if(modalClear){
      modalClear.onclick=()=>clearDateRange();
    }
    if(typeof document!=="undefined"){
      if(dateModalKeyHandler){
        document.removeEventListener('keydown',dateModalKeyHandler);
        dateModalKeyHandler=null;
      }
      if(ui.dateRangeModalOpen){
        dateModalKeyHandler=(event)=>{
          if(event.key==='Escape'){
            event.preventDefault();
            closeDateRangeModal();
            return;
          }
          if(event.key==='Enter'){
            const target=event.target;
            if(target && (target.id==='modalDateFrom' || target.id==='modalDateTo')){
              event.preventDefault();
              const from=modalFrom?modalFrom.value||"":"";
              const to=modalTo?modalTo.value||"":"";
              applyDateRangeModal(from,to);
            }
          }
        };
        document.addEventListener('keydown',dateModalKeyHandler);
        if(document.body){
          if(dateModalScrollLock===null){
            dateModalScrollLock=document.body.style.overflow;
          }
          document.body.style.overflow='hidden';
        }
      }else if(document.body && dateModalScrollLock!==null){
        document.body.style.overflow=dateModalScrollLock;
        dateModalScrollLock=null;
      }
    }
  }
  else if(typeof document!=="undefined"){
    if(dateModalKeyHandler){
      document.removeEventListener('keydown',dateModalKeyHandler);
      dateModalKeyHandler=null;
    }
    if(document.body && dateModalScrollLock!==null){
      document.body.style.overflow=dateModalScrollLock;
      dateModalScrollLock=null;
    }
  }
  const logoutBtn=$("#btnLogout");
  if(logoutBtn){
    logoutBtn.onclick=async()=>{
      logoutBtn.disabled=true;
      try{
        const res=await fetch("/api/v1/auth/logout",{method:"POST"});
        if(res.ok){
          window.location.href="/login";
          return;
        }
      }catch(err){
        console.error(err);
      }
      logoutBtn.disabled=false;
      toast("Logout failed. Try again.");
    };
  }
  const confirmOverlay=$("#confirmOverlay");
  if(confirmOverlay){
    const cancelBtn=$("#confirmCancel");
    const okBtn=$("#confirmOk");
    const backdrop=confirmOverlay.querySelector('.mask');
    if(cancelBtn) cancelBtn.onclick=()=>resolveConfirm(false);
    if(okBtn) okBtn.onclick=()=>resolveConfirm(true);
    if(backdrop) backdrop.onclick=()=>resolveConfirm(false);
    confirmOverlay.querySelectorAll('[data-close]').forEach(btn=>{
      btn.onclick=()=>resolveConfirm(false);
    });
  }
  const exportOverlay=$("#exportOverlay");
  if(exportOverlay){
    exportOverlay.querySelectorAll('[data-close]').forEach(btn=>{
      btn.onclick=()=>hideDashboardExportDialog();
    });
    const submitBtn=$("#exportSubmit");
    const form=exportOverlay.querySelector('#exportForm');
    if(submitBtn && form){
      if(!submitBtn.dataset.defaultLabel){
        submitBtn.dataset.defaultLabel=submitBtn.textContent||'Export';
      }
      submitBtn.onclick=async e=>{
        e.preventDefault();
        if(submitBtn.dataset.loading){
          return;
        }
        const selected=form.querySelector('input[name="exportMode"]:checked');
        if(!selected){
          toast("Select an export option");
          return;
        }
        const mode=selected.value;
        submitBtn.dataset.loading="1";
        submitBtn.disabled=true;
        submitBtn.textContent='Exporting…';
        try{
          await downloadExcelFile(`/api/v1/dashboard/export?mode=${encodeURIComponent(mode)}`, `dashboard-${mode}.xlsx`);
          hideDashboardExportDialog();
        }catch(err){
          console.error(err);
          toast("Export failed. Try again.");
        }finally{
          delete submitBtn.dataset.loading;
          submitBtn.disabled=false;
          submitBtn.textContent=submitBtn.dataset.defaultLabel||'Export';
        }
      };
    }
  }
  $$("#app [data-nav]").forEach(a=>a.onclick=()=>{
    $$("#app [data-nav]").forEach(link=>{
      link.classList.remove("active");
      if(!link.classList.contains("text-slate-600")) link.classList.add("text-slate-600");
    });
    a.classList.add("active");
    a.classList.remove("text-slate-600");
    route=a.getAttribute("data-nav");
    addPanel.add=addPanel.raw=addPanel.sfg=addPanel.fg=false;
    bulkMode.add=bulkMode.raw=bulkMode.sfg=bulkMode.fg=false;
    bulkSelected.add.clear(); bulkSelected.raw.clear(); bulkSelected.sfg.clear(); bulkSelected.fg.clear();
    editItemId.add=editItemId.raw=editItemId.sfg=editItemId.fg="";
    if(route!=="users"){
      usersUi.userModalOpen=false;
      usersUi.editUserId="";
      usersUi.rolesModalOpen=false;
      usersUi.roleDirty=false;
      usersUi.roleTab="visibility";
      usersUi.roleDraft=null;
      usersUi.roleOriginal=null;
      usersUi.selectedRoleKey=state.roles[0]?.id||"";
    }
    syncHistory();
    renderRoute();
    ensureEntryStream();
  });

  syncHistory();
  renderRoute();
  ensureEntryStream();
}

/* ============== Dashboard (Qty shows with units) ============== */
function buildDashboardGroupStats(){
  const active=linesForActiveSession();
  const stats={};
  const gl=groupsList(state);
  const itemGroup={}; state.items.forEach(it=>{ itemGroup[it.id]=groupOfLabel(state,it.category)||""; });
  const itemsByGroup={}; state.items.forEach(it=>{ const g=itemGroup[it.id]||""; if(!g) return; itemsByGroup[g]=(itemsByGroup[g]||0)+1; });
  const counted={}, valBy={};
  active.forEach(l=>{
    const g=groupOfLabel(state,l.categoryLabel)||""; if(!g) return;
    (counted[g] ||= new Set()).add(l.itemId);
    valBy[g]=(valBy[g]||0)+ (l.priceAtEntry==null?0:l.qty*l.priceAtEntry);
  });
  gl.forEach(g=>{
    stats[g]={categories:(state.cats?.[g]||[]).length,items:itemsByGroup[g]||0,counted:counted[g]?.size||0,value:valBy[g]||0};
  });
  return {stats, groups:gl};
}
function buildDashboardSummaryData(filterFn){
  const lines=linesForActiveSession();
  const buckets=new Map();
  lines.forEach(line=>{
    if(filterFn && !filterFn(line)) return;
    const key=`${line.itemName}||${line.categoryLabel}`;
    let bucket=buckets.get(key);
    if(!bucket){
      bucket={
        key,
        itemId:line.itemId,
        itemName:line.itemName,
        categoryLabel:line.categoryLabel,
        groupLabel:groupOfLabel(state,line.categoryLabel)||"",
        unit:line.unit,
        totalQty:0,
        totalValue:0,
        hasMissingPrice:false,
        batches:new Set(),
        lines:[],
      };
      buckets.set(key,bucket);
    }else if(!bucket.itemId && line.itemId){
      bucket.itemId=line.itemId;
    }
    if(!bucket.unit && line.unit) bucket.unit=line.unit;
    const qty=Number(line.qty)||0;
    bucket.totalQty+=qty;
    const batch=(line.batch||"").trim();
    if(batch) bucket.batches.add(batch);
    const rawPrice=line.priceAtEntry;
    const price=rawPrice==null?null:Number(rawPrice);
    if(price==null || !Number.isFinite(price)){
      bucket.hasMissingPrice=true;
    }else{
      bucket.totalValue+=qty*price;
    }
    bucket.lines.push(line);
  });
  const summary=Array.from(buckets.values()).map(bucket=>({
    key:bucket.key,
    itemId:bucket.itemId,
    itemName:bucket.itemName,
    categoryLabel:bucket.categoryLabel,
    groupLabel:bucket.groupLabel,
    unit:bucket.unit,
    batchesCount:bucket.batches.size,
    entriesCount:bucket.lines.length,
    totalQty:bucket.totalQty,
    totalValue:bucket.hasMissingPrice?null:bucket.totalValue,
    hasMissingPrice:bucket.hasMissingPrice,
    lines:bucket.lines.slice(),
  }));
  summary.sort((a,b)=>{
    const name=a.itemName.localeCompare(b.itemName);
    if(name!==0) return name;
    return a.categoryLabel.localeCompare(b.categoryLabel);
  });
  return summary;
}
let dashDetailEscHandler=null;
function openDashDetailModal(group,rowNumber){
  const modal=document.querySelector('#dashDetailModal');
  if(!modal || !group) return;
  const close=()=>{
    modal.classList.add('hidden');
    if(dashDetailEscHandler){
      document.removeEventListener('keydown',dashDetailEscHandler);
      dashDetailEscHandler=null;
    }
  };
  const title=modal.querySelector('#dashDetailTitle');
  if(title){
    title.textContent=group.itemName||'';
  }
  const subtitle=modal.querySelector('#dashDetailSubtitle');
  if(subtitle){
    const chips=[];
    if(group.categoryLabel){
      chips.push(`<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 font-medium">Category: ${H(group.categoryLabel)}</span>`);
    }
    if(group.groupLabel && group.groupLabel!==group.categoryLabel){
      chips.push(`<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 font-medium">Group: ${H(group.groupLabel)}</span>`);
    }
    if(group.unit){
      chips.push(`<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 font-medium">Unit: ${H(group.unit)}</span>`);
    }
    subtitle.innerHTML=chips.join('');
    subtitle.classList.toggle('hidden',chips.length===0);
  }
  const totalQtyText=formatQtyWithUnit(group.totalQty,group.unit);
  const totalValueText=formatINR(group.totalValue);
  const linesArray=Array.isArray(group.lines)?group.lines:[];
  const meta=modal.querySelector('#dashDetailMeta');
  if(meta){
    const metaCards=[
      {label:'Total Qty Counted',value:totalQtyText||'—'},
      {label:'Total Inventory Value',value:totalValueText},
      {label:'Unique Batches',value:group.batchesCount!=null?group.batchesCount:0},
      {label:'Entries Logged',value:linesArray.length},
    ];
    meta.innerHTML=metaCards.map(card=>`
      <div class="bg-white rounded-2xl border border-slate-200 px-4 py-3 shadow-sm">
        <span class="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">${H(card.label)}</span>
        <span class="mt-1 block text-base font-semibold text-slate-800">${H(card.value)}</span>
      </div>
    `).join('');
  }
  const exportBtn=modal.querySelector('#dashDetailExport');
  if(exportBtn){
    exportBtn.disabled=false;
    exportBtn.textContent='Export Excel';
    exportBtn.onclick=async()=>{
      const itemId=group.itemId;
      if(!isUuid(itemId)){
        toast("Export available only for synced items");
        return;
      }
      exportBtn.disabled=true;
      exportBtn.textContent='Exporting…';
      try{
        await downloadExcelFile(`/api/v1/dashboard/detail/${itemId}/export`, `${group.itemName||'dashboard'}-detail.xlsx`);
      }catch(err){
        console.error(err);
        toast("Export failed. Try again.");
      }finally{
        exportBtn.disabled=false;
        exportBtn.textContent='Export Excel';
      }
    };
  }
  if(group.hasMissingPrice){
    toast("Some entries are missing price information. Totals may be understated.");
  }
  const tbody=modal.querySelector('#dashDetailBody');
  if(tbody){
    const rows=linesArray.slice().sort((a,b)=>{
      const ta=a.createdAt||'';
      const tb=b.createdAt||'';
      if(ta!==tb) return tb.localeCompare(ta);
      return (b.id||'').localeCompare(a.id||'');
    });
    if(!rows.length){
      tbody.innerHTML=`<tr><td colspan="11" class="px-4 py-6 text-center text-slate-500">No entries</td></tr>`;
    }else{
      tbody.innerHTML=rows.map((line,idx)=>{
        const highlightClass = getEntryHighlightClass(line.id);
        const priceValue=line.priceAtEntry==null?null:Number(line.priceAtEntry);
        const priceDisplay=(priceValue==null || !Number.isFinite(priceValue))?"—":formatINR(priceValue);
        const qtyNumber=Number(line.qty);
        const hasNumericQty=Number.isFinite(qtyNumber);
        const lineValue=(priceValue==null || !Number.isFinite(priceValue) || !hasNumericQty)?null:qtyNumber*priceValue;
        const lineValueDisplay=lineValue==null?"—":formatINR(lineValue);
        return `<tr class="odd:bg-slate-50/60 even:bg-white hover:bg-cyan-50/60 transition-colors${highlightClass}">
          <td class="px-4 py-3 border-t border-slate-200 text-right text-slate-500 font-medium">${idx===0?rowNumber:""}</td>
          <td class="px-4 py-3 border-t border-slate-200 text-left text-slate-600">${H(line.createdBy||"")}</td>
          <td class="px-4 py-3 border-t border-slate-200 text-left font-semibold text-slate-800">${H(line.itemName)}</td>
          <td class="px-4 py-3 border-t border-slate-200 text-left text-slate-500">${H(line.categoryLabel)}</td>
          <td class="px-4 py-3 border-t border-slate-200 text-left text-slate-500 tracking-[0.08em] uppercase">${H(line.batch)}</td>
          <td class="px-4 py-3 border-t border-slate-200 text-left text-slate-500 whitespace-nowrap tracking-[0.05em]">${H(line.mfg||"")}</td>
          <td class="px-4 py-3 border-t border-slate-200 text-left text-slate-500 whitespace-nowrap tracking-[0.05em]">${H(line.exp||"")}</td>
          <td class="px-4 py-3 border-t border-slate-200 text-right font-semibold text-slate-700">${formatQtyWithUnit(line.qty,line.unit)}</td>
          <td class="px-4 py-3 border-t border-slate-200 text-left text-slate-500">${H(line.locationName||"")}</td>
          <td class="px-4 py-3 border-t border-slate-200 text-right text-slate-500">${priceDisplay}</td>
          <td class="px-4 py-3 border-t border-slate-200 text-right font-semibold text-slate-700">${lineValueDisplay}</td>
        </tr>`;
      }).join('');
    }
  }
  modal.querySelectorAll('[data-close]').forEach(btn=>btn.onclick=close);
  if(dashDetailEscHandler){
    document.removeEventListener('keydown',dashDetailEscHandler);
    dashDetailEscHandler=null;
  }
  dashDetailEscHandler=e=>{
    if(e.key==='Escape') close();
  };
  document.addEventListener('keydown',dashDetailEscHandler);
  modal.classList.remove('hidden');
}
function renderDashboard(){
  const page=$("#page");
  const canExportWithMaster = !!state.permissions?.can_export_dashboard_summary;
  const canExportValuated = !!state.permissions?.can_export_dashboard_entries;
  const canExportDashboard = canExportWithMaster || canExportValuated;
  const prevStats = deepClone(ui.dashboardStats || {});
  const {stats,groups}=buildDashboardGroupStats();
  ui.dashboardStats = deepClone(stats);
  page.innerHTML=`
    <h1 class="text-2xl md:text-3xl font-bold text-slate-900 mb-4">Dashboard</h1>

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
      ${groups.map(g=>{
        const s=stats[g]||{categories:0,items:0,counted:0,value:0};
        return `
    <div class="bg-white border border-slate-200 rounded-xl p-5 shadow-sm hover:-translate-y-1 hover:shadow-lg transition-all duration-200" data-dashboard-card="${H(g)}">
      <div class="font-bold text-lg mb-4 text-cyan-800">${H(g)}</div>
      <div class="text-sm space-y-2">
        <div class="flex justify-between items-center"><span class="font-medium text-slate-500">Categories:</span> <span class="font-semibold" data-stat="categories">${s.categories}</span></div>
        <div class="flex justify-between items-center"><span class="font-medium text-slate-500">Items:</span> <span class="font-semibold" data-stat="items">${s.items}</span></div>
        <div class="flex justify-between items-center"><span class="font-medium text-slate-500">Counted:</span> <span class="font-semibold" data-stat="counted">${s.counted}</span></div>
        <div class="flex justify-between items-center"><span class="font-medium text-slate-500">Total Value:</span> <span class="font-bold text-slate-700" data-stat="value">${formatINR(s.value)}</span></div>
      </div>
    </div>`;}).join("")}
    </div>

    <div class="bg-white border border-slate-200 rounded-xl p-4 mb-4 shadow-sm">
      <div class="flex flex-wrap items-center gap-3">
        <input id="dashSearch" placeholder="" class="flex-grow bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none transition"/>
        <button id="btnFilterDash" class="iconbtn">Filter</button>
        ${canExportDashboard ? '<button id="dashboardExport" class="iconbtn">Export Excel</button>' : ''}
      </div>
    </div>

    <div class="bg-white border border-slate-200 rounded-xl overflow-auto max-h-[65vh] shadow-sm">
      <table class="w-full min-w-[760px] border-collapse sticky-head text-sm">
        <thead>
          <tr class="bg-slate-100">
            ${(() => {
              const headers=["#","Item Name","Category","Batches","Entries logged","Total Qty","Total Value"];
              const numeric=new Set(["#","Batches","Entries logged","Total Qty","Total Value"]);
              return headers
                .map(h=>`<th class="text-slate-600 text-xs font-semibold px-4 py-3 ${numeric.has(h)?'text-right':'text-left'}">${H(h)}</th>`)
                .join("");
            })()}
          </tr>
        </thead>
        <tbody id="dashSummaryBody"></tbody>
      </table>
    </div>

    ${renderFilterModal('dash')}
    <div id="dashDetailModal" class="fixed inset-0 z-[80] hidden">
      <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" data-close></div>
      <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white border border-slate-200 rounded-2xl shadow-2xl w-[min(92vw,1000px)] max-h-[88vh] flex flex-col overflow-hidden">
        <div class="flex items-start justify-between gap-4 px-6 py-4 border-b border-slate-200 bg-white">
          <div class="min-w-0">
            <h3 class="text-slate-900 font-semibold text-xl leading-tight" id="dashDetailTitle"></h3>
            <div id="dashDetailSubtitle" class="mt-2 flex flex-wrap gap-2 text-xs text-slate-500"></div>
          </div>
          <div class="flex items-center gap-3">
            ${canExportValuated ? '<button id="dashDetailExport" class="px-3 py-1.5 rounded-lg bg-cyan-600 text-white text-sm font-semibold hover:bg-cyan-700 transition">Export Excel</button>' : ''}
            <button class="p-2 rounded-full hover:bg-slate-100 text-slate-500 transition" data-close>
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
          </div>
        </div>
        <div class="px-6 py-4 bg-slate-50 border-b border-slate-200">
          <div id="dashDetailMeta" class="grid auto-grid gap-4 sm:grid-cols-2 xl:grid-cols-4"></div>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto px-6 py-6 no-scrollbar">
          <div class="overflow-x-auto no-scrollbar rounded-2xl border border-slate-200 shadow-inner bg-white">
            <table class="w-full min-w-[1040px] border-collapse sticky-head text-sm">
              <thead class="bg-slate-100">
                <tr>
                  ${(() => {
                    const headers=["#","User","Item Name","Category","Batch","Mfg","Exp","Qty","Location","Price","Line Value"];
                    const numeric=new Set(["#","Qty","Price","Line Value"]);
                    return headers
                      .map(h=>`<th class="text-slate-600 text-xs font-semibold px-4 py-3 ${numeric.has(h)?'text-right':'text-left'}">${H(h)}</th>`)
                      .join("");
                  })()}
                </tr>
              </thead>
              <tbody id="dashDetailBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
  if(dashDetailEscHandler){
    document.removeEventListener('keydown',dashDetailEscHandler);
    dashDetailEscHandler=null;
  }
  const dashExportBtn=$("#dashboardExport");
  if(dashExportBtn){
    dashExportBtn.onclick=()=>showDashboardExportDialog();
  }
  let summaryRows=[];
  const paint=()=>{
    const q=$("#dashSearch").value.trim().toLowerCase();
    const filterFn=line=>{
      if(flt.dash.group!=="all" && groupOfLabel(state,line.categoryLabel)!==flt.dash.group) return false;
      if(flt.dash.sub && line.categoryLabel!==flt.dash.sub) return false;
      if(flt.dash.loc && line.locationId!==flt.dash.loc) return false;
      return true;
    };
    const rows=buildDashboardSummaryData(filterFn).filter(row=>{
      if(!q) return true;
      return row.itemName.toLowerCase().includes(q);
    });
    summaryRows=rows;
    const tbody=$("#dashSummaryBody");
    if(!tbody) return;
    if(!rows.length){
      tbody.innerHTML=`<tr><td colspan="7" class="px-4 py-6 text-center text-slate-500">No entries found</td></tr>`;
      return;
    }
    tbody.innerHTML=rows.map((row,idx)=>{
      const highlightClass = getHighlightClassForLines(row.lines);
      return `
      <tr class="hover:bg-slate-50 transition-colors cursor-pointer${highlightClass}" data-idx="${idx}">
        <td class="px-4 py-2.5 border-t border-slate-200 text-right text-slate-500">${idx+1}</td>
        <td class="px-4 py-2.5 border-t border-slate-200 text-left font-medium">${H(row.itemName)}</td>
        <td class="px-4 py-2.5 border-t border-slate-200 text-left text-slate-500">${H(row.categoryLabel)}</td>
        <td class="px-4 py-2.5 border-t border-slate-200 text-right text-slate-600">${row.batchesCount}</td>
        <td class="px-4 py-2.5 border-t border-slate-200 text-right text-slate-600">${row.entriesCount}</td>
        <td class="px-4 py-2.5 border-t border-slate-200 text-right font-semibold">${formatQtyWithUnit(row.totalQty,row.unit)}</td>
        <td class="px-4 py-2.5 border-t border-slate-200 text-right font-bold text-slate-700">${formatINR(row.totalValue)}</td>
      </tr>`;
    }).join("");
    tbody.querySelectorAll('tr[data-idx]').forEach(tr=>{
      const idx=Number(tr.getAttribute('data-idx'));
      tr.onclick=()=>{
        const data=summaryRows[idx];
        if(data) openDashDetailModal(data,idx+1);
      };
    });
  };
  $("#btnFilterDash").onclick=()=>openFilter('dash');
  $("#dashSearch").oninput=paint;
  paint();
  animateDashboardCards(prevStats, stats);
}

/* ============== Filter modal (reduced for pages) ============== */
function renderFilterModal(key){
  // On raw/sfg/fg: only Sub-category + Location
  // On add/dash: Group + Sub-category + Location
  const showGroup = (key==='add' || key==='dash');
  const showSub   = (key==='add' || key==='dash' || key==='raw' || key==='sfg' || key==='fg');

  return `
  <div id="modal_${key}" class="fixed inset-0 z-[70] hidden">
    <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" data-close></div>
    <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white border border-slate-200 rounded-2xl shadow-xl p-6" style="width:min(92vw,500px)">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-slate-800 font-bold text-lg">Filters</h3>
        <button class="p-2 rounded-full hover:bg-slate-100 text-slate-500" data-close>
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
        </button>
      </div>
      <div class="space-y-4">
        ${showGroup?`
        <div>
          <label class="block text-sm font-medium text-slate-600 mb-1">Group</label>
          <select id="flt_group_${key}" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none"></select>
        </div>`:""}
        ${showSub?`
        <div>
          <label class="block text-sm font-medium text-slate-600 mb-1">Sub category</label>
          <select id="flt_sub_${key}" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none"></select>
        </div>`:""}
        <div>
          <label class="block text-sm font-medium text-slate-600 mb-1">Location</label>
          <select id="flt_loc_${key}" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none">
            <option value="">All</option>
            ${state.locations.map(loc=>`<option value="${H(loc.id)}">${H(loc.name)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="flex justify-end gap-3 mt-6">
        <button class="iconbtn" data-close>Close</button>
        <button id="apply_${key}" class="bg-cyan-600 text-white rounded-lg px-5 py-2 text-sm font-semibold hover:bg-cyan-700 transition">Apply Filters</button>
      </div>
    </div>
  </div>`;
}
function openFilter(key){
  const modal=document.querySelector(`#modal_${key}`);
  const showGroup = (key==='add' || key==='dash');
  const showSub   = (key==='add' || key==='dash' || key==='raw' || key==='sfg' || key==='fg');

  modal.classList.remove("hidden");
  modal.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>modal.classList.add("hidden"));

  if(showGroup){
    const selG=document.querySelector(`#flt_group_${key}`);
    selG.innerHTML=`<option value="all">All Groups</option>`+groupsList(state).map(g=>`<option value="${H(g)}">${H(g)}</option>`).join("");
    selG.value=flt[key].group||"all";
  }
  if(showSub){
    const selS=document.querySelector(`#flt_sub_${key}`);
    if(key==='add' || key==='dash'){
      const selG=document.querySelector(`#flt_group_${key}`);
      const refreshSubs=()=>{
        const g=(showGroup? selG.value : 'all');
        const subs=(g && g!=='all')?subcatsOf(state,g):[];
        selS.innerHTML = `<option value="">All Sub-categories</option>`+subs.map(x=>`<option value="${H(x)}">${H(x)}</option>`).join("");
        selS.disabled=!(g && g!=='all' && subs.length);
        selS.value=flt[key].sub||"";
      };
      refreshSubs();
      if(showGroup){ selG.onchange=refreshSubs; }
    }else{
      // raw/sfg/fg -> sub list belongs to that fixed group
      const gKey = key==='raw'?G_RAW : key==='sfg'?G_SEMI : G_FG;
      const subs=subcatsOf(state,gKey);
      selS.innerHTML = `<option value="">All Sub-categories</option>`+subs.map(x=>`<option value="${H(x)}">${H(x)}</option>`).join("");
      selS.disabled = subs.length===0;
      selS.value=flt[key].sub||"";
    }
  }
  document.querySelector(`#flt_loc_${key}`).value=flt[key].loc||"";

  document.querySelector(`#apply_${key}`).onclick=()=>{
    if(showGroup)  flt[key].group=document.querySelector(`#flt_group_${key}`).value;
    if(showSub)    flt[key].sub=document.querySelector(`#flt_sub_${key}`).value;
    flt[key].loc=document.querySelector(`#flt_loc_${key}`).value;
    modal.classList.add("hidden");
    renderRoute();
  };
}

/* ============== Master Data (Add New Item) ============== */
function itemsAgg(){
  const sum=linesForActiveSession().reduce((m,l)=>{m[l.itemId]=(m[l.itemId]||0)+l.qty; return m;},{});
  return state.items.map(it=>{
    const g=groupOfLabel(state,it.category)||"";
    const sub=g && state.cats?.[g]?.includes(it.category)?it.category:"";
    return {...it,group:g,sub,qty:sum[it.id]||0};
  });
}
function renderAddPage(){
  const page=$("#page");
  const canAddItems=!!state.permissions?.can_import_master_data;
  const canEditItems=!!state.permissions?.can_edit_add_item;
  const canBulkDeleteItems=!!state.permissions?.can_bulk_edit_delete_add_item;
  if(!canAddItems && (!canEditItems || !editItemId.add)){
    addPanel.add=false;
  }
  if(!canEditItems){
    editItemId.add="";
  }
  const showAddForm = addPanel.add && ((editItemId.add && canEditItems) || (!editItemId.add && canAddItems));
  if(!canBulkDeleteItems){
    bulkMode.add=false;
    bulkSelected.add.clear();
  }
  const gl=groupsList(state);
  const editing=!!editItemId.add;
  const it=editing?state.items.find(x=>x.id===editItemId.add):null;
  const groupInit=editing?(groupOfLabel(state,it.category)||gl[0]||""):(gl[0]||"");
  const subInit=editing && state.cats[groupInit]?.includes(it.category) ? it.category : "";
  const metricsSeen=new Set();
  const metricsList=[];
  (state.metrics||[]).forEach(unit=>{
    const trimmed=(unit==null?"":String(unit)).trim();
    if(!trimmed) return;
    const key=trimmed.toLowerCase();
    if(metricsSeen.has(key)) return;
    metricsSeen.add(key);
    metricsList.push(trimmed);
  });
  if(editing && it?.unit){
    const trimmed=String(it.unit).trim();
    if(trimmed){
      const key=trimmed.toLowerCase();
      if(!metricsSeen.has(key)){
        metricsSeen.add(key);
        metricsList.push(trimmed);
      }
    }
  }
  const metricsOptions=metricsList
    .slice()
    .sort((a,b)=>a.localeCompare(b))
    .map(unit=>{
      const selected=editing && String(it?.unit||"").toLowerCase()===unit.toLowerCase();
      return `<option value="${H(unit)}" ${selected?'selected':''}>${H(unit)}</option>`;
    }).join("");

  page.innerHTML=`
    <h1 class="text-2xl md:text-3xl font-bold text-slate-900 mb-4">Master Data</h1>

    <div class="bg-white border border-slate-200 rounded-xl p-4 mb-4 shadow-sm">
      <div class="flex flex-wrap items-center gap-3">
        <input id="addSearch" placeholder="" class="flex-grow bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none transition"/>
        <button id="btnAddFilter" class="iconbtn">Filter</button>
        ${canAddItems ? `<button id="btnImportItems" class="iconbtn ${bulkMode.add ? 'hidden' : ''}">Import Excel</button>` : ''}
        ${canAddItems ? `<button id="btnOpenAdd" class="bg-cyan-600 text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-cyan-700 transition ${bulkMode.add ? 'hidden' : ''}">Add Item</button>` : ''}
        ${canBulkDeleteItems ? `<button id="btnBulkAdd" class="iconbtn">${bulkMode.add ? 'Cancel Bulk Delete' : 'Bulk Delete'}</button>` : ''}
        ${canBulkDeleteItems && bulkMode.add ? `<button id="btnDelSelAdd" class="iconbtn bg-red-500 text-white hover:bg-red-600">Delete Selected</button>` : ''}
      </div>
    </div>

    ${showAddForm ? `
    <div class="bg-white border border-slate-200 rounded-xl p-6 mb-4 shadow-lg relative fade">
      <button id="closeAddPanel" class="absolute right-3 top-3 p-2 rounded-full hover:bg-slate-100 text-slate-500" title="Close">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
      </button>
      <h3 class="text-slate-800 font-bold text-lg mb-4">${editing?"Edit Item":"Add New Item"}</h3>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <div>
          <label class="block text-sm font-medium text-slate-600 mb-1">Item Name</label>
          <input id="it_name" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none" value="${editing?H(it.name):""}"/>
        </div>
        <div>
          <label class="block text-sm font-medium text-slate-600 mb-1">Category (Group)</label>
          <select id="it_group" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none">
            ${gl.map(g=>`<option ${g===groupInit?'selected':''}>${H(g)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium text-slate-600 mb-1">Sub Category</label>
          <select id="it_sub" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none"></select>
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
        <div>
          <label class="block text-sm font-medium text-slate-600 mb-1">Unit</label>
          <select id="it_unit" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none">
            <option value="">Select unit</option>
            ${metricsOptions}
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium text-slate-600 mb-1">Price (₹)</label>
          <input id="it_price" type="number" step="0.01" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none" value="${editing?H(it.price??""):""}"/>
        </div>
      </div>
      <div class="flex items-center gap-3">
        ${editing?`
          <button id="btnUpdateItem" class="bg-cyan-600 text-white rounded-lg px-5 py-2 text-sm font-semibold hover:bg-cyan-700 transition">Save</button>
          ${canBulkDeleteItems ? `<button id="btnDeleteItem" class="iconbtn text-red-600 hover:bg-red-50">🗑 Delete</button>` : ''}
        `:`
          <button id="btnSaveItem" class="bg-cyan-600 text-white rounded-lg px-5 py-2 text-sm font-semibold hover:bg-cyan-700 transition">Save</button>
        `}
      </div>
    </div>`:""}

    <div class="bg-white border border-slate-200 rounded-xl overflow-auto max-h-[65vh] shadow-sm">
      <table class="w-full min-w-[900px] border-collapse sticky-head text-sm">
        <thead class="bg-slate-100">
          <tr>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-left">Item Name</th>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-left">Group</th>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-left">Sub Category</th>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-right">Unit</th>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-right">Price</th>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-right">
              ${canBulkDeleteItems && bulkMode.add?`<input id="selAll_add" type="checkbox" class="h-4 w-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500" title="Select All"/>`:"Actions"}
            </th>
          </tr>
        </thead>
        <tbody id="itemsBody"></tbody>
      </table>
    </div>

    ${renderFilterModal("add")}
  `;
  const openAddBtn=$("#btnOpenAdd");
  if(openAddBtn) openAddBtn.onclick=()=>{ addPanel.add=true; editItemId.add=""; renderAddPage(); };
  const bulkAddBtn=$("#btnBulkAdd");
  if(bulkAddBtn) bulkAddBtn.onclick=()=>{ bulkMode.add=!bulkMode.add; bulkSelected.add.clear(); addPanel.add=false; editItemId.add=""; renderAddPage(); };
  if($("#btnDelSelAdd")) $("#btnDelSelAdd").onclick=async()=>{
    if(!bulkSelected.add.size){ toast("Select at least one item"); return; }
    const ok=await confirmDialog("Delete selected items and all their entries?");
    if(!ok) return;
    const ids=Array.from(bulkSelected.add);
    const button=$("#btnDelSelAdd");
    try{
      if(button) button.disabled=true;
      for(const itemId of ids){
        await deleteEntriesForItem(itemId);
        await api.delete(`/items/${encodeURIComponent(itemId)}`);
      }
      await refreshItems();
      removeEntriesByItemIds(ids);
      bulkSelected.add.clear();
      bulkMode.add=false;
      addPanel.add=false;
      renderAddPage();
      toast("Items deleted");
    }catch(err){
      toast(err?.message||'Failed to delete items');
    }finally{
      if(button) button.disabled=false;
    }
  };
  if($("#closeAddPanel")) $("#closeAddPanel").onclick=()=>{ addPanel.add=false; editItemId.add=""; renderAddPage(); };

  function refreshSub(g,selVal=""){
    const sel=$("#it_sub"); const subs=subcatsOf(state,g);
    sel.innerHTML = subs.length ? `<option value="">(None)</option>`+subs.map(x=>`<option ${x===selVal?'selected':''}>${H(x)}</option>`).join("")
                                : `<option value="">— No sub-categories —</option>`;
    sel.disabled=!subs.length;
  }
  if(addPanel.add){
    $("#it_group").onchange=e=>refreshSub(e.target.value);
    refreshSub(groupInit,subInit);

    if(editItemId.add){
      const updateBtn=$("#btnUpdateItem");
      if(updateBtn) updateBtn.onclick=async()=>{
        const item=state.items.find(x=>x.id===editItemId.add); if(!item){ toast("Item not found"); return; }
        const name=$("#it_name").value.trim();
        const unit=$("#it_unit").value.trim();
        const group=$("#it_group").value.trim();
        const sub=$("#it_sub").value.trim();
        const priceStr=$("#it_price").value.trim();
        if(!name||!unit||!group){ toast("Name, unit & category are required"); return; }
        if(state.items.some(i=>i.id!==item.id && i.name.toLowerCase()===name.toLowerCase())){ toast("Another item with this name exists"); return; }
        const price=priceStr===""?null:Number(priceStr);
        if(priceStr!=="" && !Number.isFinite(price)){ toast("Price must be a number"); return; }
        const categoryId=sub?state.categoryMeta?.subNameToId?.get(sub):null;
        if(sub && !categoryId){ toast("Select a valid sub-category"); return; }
        const button=updateBtn;
        try{
          if(button) button.disabled=true;
          await api.put(`/items/${encodeURIComponent(item.id)}`, {
            name,
            unit,
            price: price==null?null:price,
            category_id: categoryId||null,
          });
          await refreshItems();
          const updatedItem=lookupItemById(item.id);
          if(updatedItem) applyItemToEntries(updatedItem);
          addPanel.add=false;
          editItemId.add="";
          renderAddPage();
          toast("Item saved");
        }catch(err){
          toast(err?.message||'Failed to update item');
        }finally{
          if(button) button.disabled=false;
        }
      };
      const deleteItemBtn=$("#btnDeleteItem");
      if(deleteItemBtn) deleteItemBtn.onclick=async()=>{
        const item=state.items.find(x=>x.id===editItemId.add); if(!item){ toast("Item not found"); return; }
        const ok=await confirmDialog(`Delete "${item.name}" and all entries?`);
        if(!ok) return;
        const button=deleteItemBtn;
        try{
          if(button) button.disabled=true;
          await deleteEntriesForItem(item.id);
          await api.delete(`/items/${encodeURIComponent(item.id)}`);
          await refreshItems();
          removeEntriesByItemIds([item.id]);
          addPanel.add=false;
          editItemId.add="";
          renderAddPage();
          toast("Item & entries removed");
        }catch(err){
          toast(err?.message||'Failed to delete item');
        }finally{
          if(button) button.disabled=false;
        }
      };
    }else{
      $("#btnSaveItem").onclick=async()=>{
        const name=$("#it_name").value.trim();
        const unit=$("#it_unit").value.trim();
        const group=$("#it_group").value.trim();
        const sub=$("#it_sub").value.trim();
        const priceStr=$("#it_price").value.trim();
        if(!name||!unit||!group){ toast("Name, unit & category are required"); return; }
        if(state.items.some(i=>i.name.toLowerCase()===name.toLowerCase())){ toast("Item already exists"); return; }
        const price=priceStr?Number(priceStr):null;
        if(priceStr && !Number.isFinite(price)){ toast("Price must be a number"); return; }
        const categoryId=sub?state.categoryMeta?.subNameToId?.get(sub):null;
        if(sub && !categoryId){ toast("Select a valid sub-category"); return; }
        const button=$("#btnSaveItem");
        try{
          if(button) button.disabled=true;
          await api.post('/items/', {
            name,
            unit,
            price: price==null?null:price,
            category_id: categoryId||null,
          });
          await refreshItems();
          addPanel.add=true;
          renderAddPage();
          toast("Item saved");
          const nameInput=$("#it_name"); const unitInput=$("#it_unit"); const priceInput=$("#it_price");
          if(nameInput) nameInput.value="";
          if(unitInput) unitInput.value="";
          if(priceInput) priceInput.value="";
          if(nameInput) nameInput.focus();
        }catch(err){
          toast(err?.message||'Failed to save item');
        }finally{
          if(button) button.disabled=false;
        }
      };
    }
  }
  let importInput=null;
  if(canAddItems){
    importInput=document.createElement('input');
    importInput.type='file';
    importInput.accept='.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    importInput.className='hidden';
    page.appendChild(importInput);
  }

  const handleImportResult=async(file)=>{
    if(!file){ return; }
    const btn=$("#btnImportItems");
    const originalLabel=btn?btn.innerHTML:"";
    try{
      if(btn){ btn.disabled=true; btn.innerHTML='<span class="opacity-80">Importing…</span>'; }
      const formData=new FormData();
      formData.append('file',file);
      const res=await fetch('/api/v1/items/import',{method:'POST',body:formData});
      if(!res.ok){
        let message='Import failed';
        try{
          const payload=await res.json();
          if(payload?.detail) message=payload.detail;
        }catch{}
        throw new Error(message);
      }
      const payload=await res.json();
      const fragments=[
        `Imported ${payload.created || 0} new items`,
        `updated ${payload.updated || 0}`,
      ];
      if(payload.skipped){
        fragments.push(`${payload.skipped} skipped`);
      }
      toast(fragments.join(', ')+'.');
      renderAddPage();
    }catch(err){
      toast(err?.message || 'Import failed');
    }finally{
      if(btn){ btn.disabled=false; btn.innerHTML=originalLabel; }
      importInput.value='';
    }
  };

  const filterBtn=$("#btnAddFilter");
  if(filterBtn) filterBtn.onclick=()=>openFilter("add");
  const searchInput=$("#addSearch");
  if(searchInput) searchInput.oninput=()=>paintItems();
  const importBtn=$("#btnImportItems");
  if(importBtn && importInput){
    importBtn.onclick=()=>importInput.click();
    importInput.onchange=()=>handleImportResult(importInput.files?.[0]);
  }

  function attachSelectAllHandler(ids){
    const hdr=$("#selAll_add"); if(!hdr) return;
    hdr.checked=ids.length>0 && ids.every(id=>bulkSelected.add.has(id));
    hdr.indeterminate=ids.some(id=>bulkSelected.add.has(id)) && !hdr.checked;
    hdr.onchange=()=>{
      const check=hdr.checked;
      $$('[data-sel]', $("#itemsBody")).forEach(cb=>{
        cb.checked=check;
        const id=cb.getAttribute("data-sel");
        if(check) bulkSelected.add.add(id); else bulkSelected.add.delete(id);
      });
    };
  }
  function paintItems(){
    const q=$("#addSearch").value.trim().toLowerCase();
    const groupOrder = new Map(CORE_GROUP_NAMES.map((name, idx) => [name.toLowerCase(), idx]));
    const rows=itemsAgg().filter(r=>{
      if(q && !r.name.toLowerCase().includes(q)) return false;
      if(flt.add.group!=="all" && r.group!==flt.add.group) return false;
      if(flt.add.sub && r.sub!==flt.add.sub) return false;
      return true;
    })
    .sort((a,b)=>{
      const aGroupKey=(a.group||"").toLocaleLowerCase();
      const bGroupKey=(b.group||"").toLocaleLowerCase();
      const aOrder=groupOrder.has(aGroupKey)?groupOrder.get(aGroupKey):groupOrder.size;
      const bOrder=groupOrder.has(bGroupKey)?groupOrder.get(bGroupKey):groupOrder.size;
      if(aOrder!==bOrder) return aOrder-bOrder;
      if(aOrder===groupOrder.size && aGroupKey!==bGroupKey){
        return aGroupKey.localeCompare(bGroupKey);
      }
      const aCat=(a.sub||a.group||"").toLocaleLowerCase();
      const bCat=(b.sub||b.group||"").toLocaleLowerCase();
      if(aCat!==bCat) return aCat.localeCompare(bCat);
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    const ids=rows.map(r=>r.id);
    let currentCategoryKey=null;
    const html=rows.map(r=>{
      const labelRaw=r.sub||r.group||"Uncategorized";
      const categoryKey=labelRaw.toLocaleLowerCase();
      const showHeader=categoryKey!==currentCategoryKey;
      if(showHeader){
        currentCategoryKey=categoryKey;
      }
      const highlightClass = getEntryHighlightClass(r.id);
      return `
      ${showHeader?`
        <tr class="bg-slate-100">
          <td colspan="6" class="px-4 py-2 text-xs font-semibold tracking-wide text-slate-600 uppercase border-t border-slate-200">${H(labelRaw)}</td>
        </tr>
      `:""}
      <tr class="hover:bg-slate-50 transition-colors${highlightClass}">
        <td class="px-4 py-2.5 border-t border-slate-200 font-medium">${H(r.name)}</td>
        <td class="px-4 py-2.5 border-t border-slate-200 text-slate-500">${r.group||"—"}</td>
        <td class="px-4 py-2.5 border-t border-slate-200 text-slate-500">${r.sub||(r.group?"—":"")}</td>
        <td class="px-4 py-2.5 border-t border-slate-200 text-right text-slate-500">${H(r.unit||"")}</td>
        <td class="px-4 py-2.5 border-t border-slate-200 text-right font-medium">${r.price==null?"—":formatINR(r.price)}</td>
        <td class="px-4 py-2.5 border-t border-slate-200 text-right">
        ${canBulkDeleteItems && bulkMode.add?`<input type="checkbox" data-sel="${H(r.id)}" class="h-4 w-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500" ${bulkSelected.add.has(r.id)?"checked":""}/>`
                         :canEditItems?`<button class="p-1.5 rounded-md text-slate-500 hover:bg-slate-200" title="Edit" data-edit="${H(r.id)}">✎</button>`:'<span class="text-xs text-slate-400">—</span>'}
        </td>
      </tr>`;}).join("");
    $("#itemsBody").innerHTML=html;
    if(canEditItems){
      $$('[data-edit]').forEach(b=>b.onclick=()=>{ editItemId.add=b.getAttribute("data-edit"); addPanel.add=true; renderAddPage(); });
    }
    if(canBulkDeleteItems){
      $$('[data-sel]').forEach(cb=>cb.onchange=()=>{ const id=cb.getAttribute("data-sel"); if(cb.checked) bulkSelected.add.add(id); else bulkSelected.add.delete(id); attachSelectAllHandler(ids); });
      attachSelectAllHandler(ids);
    }
  }
  paintItems();
}

/* ============== Entry Pages (Raw / Semi Finished / Finished) ============== */
function renderEntryPage(type){
  const key=type.toLowerCase();
  const G_KEY = type==='RAW'?G_RAW:(type==='SFG'?G_SEMI:G_FG);
  const page=$("#page");
  const subs=subcatsOf(state,G_KEY);

  // Items available per current sub filter (if set)
  const availableItems = state.items
    .filter(i => groupOfLabel(state,i.category)===G_KEY)
    .filter(i => !flt[key].sub || i.category===flt[key].sub)
    .sort((a,b)=>a.name.localeCompare(b.name));

  const locations=Array.isArray(state.locations)?state.locations:[];
  const editingLine=editItemId[key]?state.lines.find(l=>l.id===editItemId[key]):null;
  ensureEntryDrafts();
  const draft=!editingLine?getEntryDraft(key):null;
  const draftItemRaw=draft?.item?String(draft.item):"";
  const draftItemValue=draftItemRaw.trim();
  const draftQty=draft?.qty?String(draft.qty):"";
  const draftBatch=draft?.batch?String(draft.batch):"";
  const draftMfg=draft?.mfg?String(draft.mfg):"";
  const draftExp=draft?.exp?String(draft.exp):"";
  const draftLocationId=draft?.locationId?String(draft.locationId):"";
  const draftDateRaw=draft?.date?String(draft.date).trim():"";
  const draftDate=/^\d{4}-\d{2}-\d{2}$/.test(draftDateRaw)?draftDateRaw:"";
  const stickyRoot=(state.entrySticky && typeof state.entrySticky==="object")?state.entrySticky:{};
  const stickyConfig=stickyRoot?.[key]||{item:"",locationId:""};
  const desiredStickyItem=editingLine?editingLine.itemName:(stickyConfig.item||"");
  const stickyAvailable=desiredStickyItem && availableItems.some(i=>i.name===desiredStickyItem);
  let initialItemValue="";
  if(editingLine){
    initialItemValue=editingLine.itemName;
  }else if(draftItemValue){
    const match=availableItems.find(i=>i.name.toLowerCase()===draftItemValue.toLowerCase());
    initialItemValue=match?match.name:draftItemValue;
  }else{
    initialItemValue=stickyAvailable?desiredStickyItem:"";
  }
  const desiredLocationId=editingLine?editingLine.locationId:(stickyConfig.locationId||"");
  const hasStickyLocation=desiredLocationId && locations.some(loc=>loc.id===desiredLocationId);
  const hasDraftLocation=draftLocationId && locations.some(loc=>loc.id===draftLocationId);
  const initialLocationId=editingLine?editingLine.locationId:(hasDraftLocation?draftLocationId:(hasStickyLocation?desiredLocationId:(locations[0]?.id||"")));
  const allowTyping=availableItems.length>0 && !editingLine;
  const itemAttrParts=[];
  if(!allowTyping) itemAttrParts.push("readonly");
  if(editingLine) itemAttrParts.push('tabindex="-1"');
  const itemExtraAttrs=itemAttrParts.join(" ").trim();
  const linesAll = linesForActiveSession()
    .filter(l => groupOfLabel(state,l.categoryLabel)===G_KEY);

  const pageTitle=type==='RAW'?'Raw Materials':type==='SFG'?'Semi Finished':'Finished Goods';
  const showMfgExp = type==='SFG' || type==='FG';
  const permSuffix=key;
  const canAddEntry=!!state.permissions?.[`can_add_entry_${permSuffix}`];
  const canBulkDelete=!!state.permissions?.[`can_bulk_edit_delete_${permSuffix}`];
  const canEditEntry=!!state.permissions?.[`can_edit_entry_${permSuffix}`];
  if(!canAddEntry && !editItemId[key]) addPanel[key]=false;
  if(!canBulkDelete){
    bulkMode[key]=false;
    bulkSelected[key].clear();
  }
  if(!canEditEntry){
    editItemId[key]="";
    if(!canAddEntry) addPanel[key]=false;
  }
  const currentRange=getDateRange();
  const editingDateSource=editingLine?.entryDate || (editingLine?.createdAt ? editingLine.createdAt.slice(0,10):"");
  const entryDateInitial=editingLine
    ? deriveEntryDateValue(editingDateSource || currentRange.to || currentRange.from || "")
    : (draftDate || deriveEntryDateValue(currentRange.to || currentRange.from || ""));
  const formGridClass = showMfgExp ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-8" : "grid-cols-1 md:grid-cols-2 xl:grid-cols-6";
  const dateColClass="xl:col-span-1";
  const itemColClass = showMfgExp ? "xl:col-span-3" : "xl:col-span-3";
  const qtyColClass="xl:col-span-1";
  const batchColClass="xl:col-span-1";
  const mfgColClass="xl:col-span-1";
  const expColClass="xl:col-span-1";
  const locationColClass = showMfgExp ? "xl:col-span-2" : "xl:col-span-2";
  const saveColClass="xl:col-span-1";
  const addButtonHtml = canAddEntry ? `<button id="${key}_add" class="bg-cyan-600 text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-cyan-700 transition ${bulkMode[key] ? 'hidden' : ''}">Add Entry</button>` : "";
  const bulkButtonHtml = canBulkDelete ? `<button id="${key}_bulk" class="iconbtn">${bulkMode[key] ? 'Cancel Bulk Delete' : 'Bulk Delete'}</button>` : "";
  const bulkDeleteActionHtml = canBulkDelete && bulkMode[key] ? `<button id="${key}_del" class="iconbtn bg-red-500 text-white hover:bg-red-600">Delete Selected</button>` : "";
  const allowForm = addPanel[key] && (editItemId[key] ? canEditEntry : canAddEntry);

  page.innerHTML=`
    <h1 class="text-2xl md:text-3xl font-bold text-slate-900 mb-4">${pageTitle}</h1>

    <div class="bg-white border border-slate-200 rounded-xl p-4 mb-4 shadow-sm">
      <div class="flex flex-wrap items-center gap-3">
        <input id="${key}_search" placeholder="" class="flex-grow bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none transition"/>
        <button id="${key}_filter" class="iconbtn">Filter</button>
        ${addButtonHtml}
        ${bulkButtonHtml}
        ${bulkDeleteActionHtml}
      </div>
    </div>

    ${allowForm?`
    <div class="bg-white border border-slate-200 rounded-xl p-6 mb-4 shadow-lg relative fade">
      <button id="${key}_close" class="absolute right-3 top-3 p-2 rounded-full hover:bg-slate-100 text-slate-500" title="Close">
         <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
      </button>
      <h3 class="text-slate-800 font-bold text-lg mb-4">${editItemId[key]?"Edit Entry":"Add New Entry"}</h3>
      <div class="grid ${formGridClass} gap-4 items-end">
        <div class="${dateColClass}">
          <label class="block text-sm font-medium text-slate-600 mb-1">Date</label>
          <input id="${key}_date" type="date" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none" value="${H(entryDateInitial)}" />
        </div>
        <div class="${itemColClass} entry-item-col">
          <label class="block text-sm font-medium text-slate-600 mb-1">Item</label>
          <div class="relative" data-item-picker="${key}">
            <input id="${key}_item" value="${H(initialItemValue)}" placeholder="${availableItems.length?"Search item":"No items available"}" autocomplete="off" spellcheck="false" class="entry-item-input w-full bg-white border border-slate-300 rounded-lg px-3 py-2 pr-9 text-sm focus:ring-2 focus:ring-cyan-500 outline-none" ${itemExtraAttrs} />
            <span class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-slate-400">
              <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 10.939l3.71-3.71a.75.75 0 1 1 1.06 1.061l-4.24 4.243a.75.75 0 0 1-1.06 0L5.21 8.29a.75.75 0 0 1 .02-1.08z" clip-rule="evenodd" />
              </svg>
            </span>
            <div id="${key}_item_panel" class="entry-item-panel absolute top-full left-0 right-0 mt-1 hidden bg-white border border-slate-200 rounded-xl shadow-lg max-h-60 overflow-y-auto no-scrollbar z-30"></div>
          </div>
        </div>
        <div class="${qtyColClass}">
          <label class="block text-sm font-medium text-slate-600 mb-1">Quantity</label>
          <input id="${key}_qty" type="number" inputmode="decimal" step="any" min="0" placeholder="" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none"/>
        </div>
        <div class="${batchColClass}">
          <label class="block text-sm font-medium text-slate-600 mb-1">Batch No.</label>
          <input id="${key}_batch" placeholder="" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none tracking-[0.08em]"/>
        </div>
        ${showMfgExp?`
        <div class="${mfgColClass}">
          <label class="block text-sm font-medium text-slate-600 mb-1">Mfg</label>
          <input id="${key}_mfg" placeholder="MM/YYYY" autocomplete="off" spellcheck="false" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none tracking-[0.05em]"/>
        </div>
        <div class="${expColClass}">
          <label class="block text-sm font-medium text-slate-600 mb-1">Exp</label>
          <input id="${key}_exp" placeholder="MM/YYYY" autocomplete="off" spellcheck="false" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none tracking-[0.05em]"/>
        </div>
        `:""}
        <div class="${locationColClass}">
          <label class="block text-sm font-medium text-slate-600 mb-1">Location</label>
          <select id="${key}_loc" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none">
            ${locations.map(loc=>`<option value="${H(loc.id)}">${H(loc.name)}</option>`).join("")}
          </select>
        </div>
        <div class="${saveColClass} flex items-end">
          <div class="flex items-center gap-2 w-full">
            ${editItemId[key] && canEditEntry ? `<button id="${key}_delete" class="w-full bg-red-500 text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-red-600 transition">Delete</button>` : ''}
            <button id="${key}_save" class="w-full bg-cyan-600 text-white rounded-lg px-5 py-2 text-sm font-semibold hover:bg-cyan-700 transition">Save</button>
          </div>
        </div>
      </div>
    </div>`:""}

    <div class="bg-white border border-slate-200 rounded-xl overflow-auto max-h-[65vh] shadow-sm">
      <table class="w-full min-w-[1120px] border-collapse sticky-head text-sm">
        <thead class="bg-slate-100">
          <tr>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-right">#</th>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-left">User</th>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-left">Item Name</th>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-left">Category</th>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-left">Batch</th>
            ${showMfgExp?`
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-left">Mfg</th>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-left">Exp</th>
            `:""}
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-right">Qty</th>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-left">Location</th>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-right">Total Qty</th>
            <th class="text-slate-600 text-xs font-semibold px-4 py-3 text-right">
              ${canBulkDelete && bulkMode[key]?`<input id="selAll_${key}" type="checkbox" class="h-4 w-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500" title="Select All"/>`:"Actions"}
            </th>
          </tr>
        </thead>
        <tbody id="${key}_body"></tbody>
      </table>
    </div>

    ${renderFilterModal(key)}
  `;

  // Top controls
  const addBtnEl=document.querySelector(`#${key}_add`);
  if(addBtnEl) addBtnEl.onclick=()=>{
    const range=getDateRange();
    if(!range.from){
      toast("Select a date in the main filter first");
      openDateRangeModal();
      return;
    }
    addPanel[key]=true; editItemId[key]=""; renderEntryPage(type);
  };
  const bulkBtnEl=document.querySelector(`#${key}_bulk`);
  if(bulkBtnEl) bulkBtnEl.onclick=()=>{ bulkMode[key]=!bulkMode[key]; bulkSelected[key].clear(); addPanel[key]=false; editItemId[key]=""; renderEntryPage(type); };
  const deleteBulkBtn=document.querySelector(`#${key}_del`);
  if(deleteBulkBtn) deleteBulkBtn.onclick=async()=>{
    if(!bulkSelected[key].size){ toast("Select lines"); return; }
    const ok=await confirmDialog("Delete selected entries?");
    if(!ok) return;
    const ids=Array.from(bulkSelected[key]);
    const button=deleteBulkBtn;
    try{
      if(button) button.disabled=true;
      await api.delete('/entries/bulk', { entry_ids: ids });
      await refreshEntries(type);
      bulkSelected[key].clear();
      bulkMode[key]=false;
      renderEntryPage(type);
      toast("Entries deleted");
    }catch(err){
      toast(err?.message||'Failed to delete entries');
    }finally{
      if(button) button.disabled=false;
    }
  };
  const closeBtn=document.querySelector(`#${key}_close`);
  if(closeBtn) closeBtn.onclick=()=>{ addPanel[key]=false; editItemId[key]=""; renderEntryPage(type); };
  document.querySelector(`#${key}_filter`).onclick=()=>openFilter(key);

  // Add/Edit Entry handlers
  if(addPanel[key]){
    const dateField=document.querySelector(`#${key}_date`);
    const itemField=document.querySelector(`#${key}_item`);
    const qtyField=document.querySelector(`#${key}_qty`);
    const batchField=document.querySelector(`#${key}_batch`);
    const locField=document.querySelector(`#${key}_loc`);
    const mfgField=document.querySelector(`#${key}_mfg`);
    const expField=document.querySelector(`#${key}_exp`);
    enforceUppercaseInput(batchField);
    enforceNumericInput(qtyField);
    attachMonthYearFormatter(mfgField);
    attachMonthYearFormatter(expField);
    if(dateField && entryDateInitial){ dateField.value = entryDateInitial; }
    if(itemField){
      itemField.addEventListener('change',()=>{ itemField.value=itemField.value.trim(); });
    }
    if(allowTyping){
      const pickerContainer=document.querySelector(`[data-item-picker="${key}"]`);
      const dropdownPanel=document.querySelector(`#${key}_item_panel`);
      initItemPicker(key,pickerContainer,itemField,dropdownPanel,availableItems);
    }else{
      cleanupItemPicker(key);
    }
    if(!editingLine){
      if(itemField && initialItemValue) itemField.value=initialItemValue;
      if(dateField && draftDate) dateField.value=draftDate;
      if(qtyField && draftQty) qtyField.value=draftQty;
      if(batchField && draftBatch) batchField.value=draftBatch.toUpperCase();
      if(locField && initialLocationId) locField.value=initialLocationId;
      if(mfgField && draftMfg) mfgField.value=draftMfg;
      if(expField && draftExp) expField.value=draftExp;
      const bindDraft=(element,field,events=["input"])=>{
        if(!element) return;
        const handler=()=>setEntryDraftValue(key,field,element.value||"");
        events.forEach(evt=>element.addEventListener(evt,handler));
      };
      bindDraft(dateField,'date',['input','change']);
      bindDraft(itemField,'item',['input','change']);
      bindDraft(qtyField,'qty',['input','change']);
      bindDraft(batchField,'batch',['input','change']);
      bindDraft(locField,'locationId',['change']);
      bindDraft(mfgField,'mfg',['input','blur']);
      bindDraft(expField,'exp',['input','blur']);
    }else{
      const editDateValue=deriveEntryDateValue(editingLine.entryDate || (editingLine.createdAt?editingLine.createdAt.slice(0,10):"")) || entryDateInitial || "";
      if(dateField) dateField.value=editDateValue;
      if(itemField) itemField.value=editingLine.itemName;
      if(qtyField) qtyField.value=editingLine.qty;
      if(batchField) batchField.value=(editingLine.batch||"").toUpperCase();
      if(locField) locField.value=editingLine.locationId||"";
      if(mfgField) mfgField.value=editingLine.mfg||"";
      if(expField) expField.value=editingLine.exp||"";
    }
    const saveBtn=document.querySelector(`#${key}_save`);
    if(saveBtn){
      saveBtn.onclick=async()=>{
        const isEdit=!!editItemId[key];
        if(isEdit && !canEditEntry){ toast("You do not have permission to edit entries."); return; }
        if(!isEdit && !canAddEntry){ toast("You do not have permission to add entries."); return; }
        if(isEdit){
          const entry=state.lines.find(l=>l.id===editItemId[key]);
          if(!entry){ toast("Entry not found"); return; }
          const dateValue=dateField?deriveEntryDateValue(dateField.value):"";
          if(!dateValue){ toast("Select a valid date"); return; }
          const qtyValue=evaluateQtyInput(qtyField?qtyField.value:"");
          if(!Number.isFinite(qtyValue)||qtyValue<=0){ toast("Enter a valid quantity"); return; }
          const batchValue=batchField?batchField.value.trim().toUpperCase():"";
          const locId=locField?locField.value.trim():"";
          const loc=state.locations.find(location=>location.id===locId);
          if(!loc){ toast("Select a location"); return; }
          const rawMfg=mfgField?mfgField.value.trim():"";
          const rawExp=expField?expField.value.trim():"";
          const mfgValue=formatMonthYear(rawMfg)||rawMfg;
          const expValue=formatMonthYear(rawExp)||rawExp;
          if(mfgField) mfgField.value=mfgValue;
          if(expField) expField.value=expValue;
          try{
            saveBtn.disabled=true;
            await api.put(`/entries/${encodeURIComponent(entry.id)}`, {
              qty: qtyValue,
              warehouse_id: loc.id,
              batch: batchValue||null,
              mfg: mfgValue||null,
              exp: expValue||null,
              entry_date: dateValue,
            });
            await refreshEntries(type);
            state.entrySticky[key]={item:entry.itemName,locationId:loc.id};
            addPanel[key]=false;
            editItemId[key]="";
            renderEntryPage(type);
            toast("Entry saved");
          }catch(err){
            toast(err?.message||'Failed to update entry');
          }finally{
            saveBtn.disabled=false;
          }
        }else{
          const typedName=itemField?itemField.value.trim():"";
          if(!typedName){ toast("Select an item"); return; }
          const item=availableItems.find(i=>i.name.toLowerCase()===typedName.toLowerCase());
          if(!item){ toast(`Select an existing item in ${pageTitle}`); return; }
          const dateValue=dateField?deriveEntryDateValue(dateField.value):"";
          if(!dateValue){ toast("Select a valid date"); return; }
          const qtyValue=evaluateQtyInput(qtyField?qtyField.value:"");
          if(!Number.isFinite(qtyValue)||qtyValue<=0){ toast("Enter a valid quantity"); return; }
          const locId=locField?locField.value:"";
          const loc=state.locations.find(location=>location.id===locId);
          if(!loc){ toast("Select a location"); return; }
          const sessionId=state.activeSessionId;
          if(!sessionId){ toast("Select a stock-taking session"); return; }
          const batchValue=batchField?batchField.value.trim().toUpperCase():"";
          const rawMfg=mfgField?mfgField.value.trim():"";
          const rawExp=expField?expField.value.trim():"";
          const mfgValue=formatMonthYear(rawMfg)||rawMfg;
          const expValue=formatMonthYear(rawExp)||rawExp;
          if(mfgField) mfgField.value=mfgValue;
          if(expField) expField.value=expValue;
          try{
            saveBtn.disabled=true;
            await api.post('/entries/', {
              session_id: sessionId,
              item_id: item.id,
              category_id: item.categoryId||null,
              type: key,
              unit: item.unit,
              qty: qtyValue,
              warehouse_id: loc.id,
              batch: batchValue||null,
              price_at_entry: item.price==null?null:item.price,
              mfg: mfgValue||null,
              exp: expValue||null,
              entry_date: dateValue,
            });
            await refreshEntries(type);
            state.entrySticky[key]={item:item.name,locationId:loc.id};
            clearEntryDraft(key);
            renderEntryPage(type);
            toast("Entry saved");
            setTimeout(()=>{
              const qtyNode=document.querySelector(`#${key}_qty`);
              const batchNode=document.querySelector(`#${key}_batch`);
              const mfgNode=document.querySelector(`#${key}_mfg`);
              const expNode=document.querySelector(`#${key}_exp`);
              if(qtyNode) qtyNode.value="";
              if(batchNode) batchNode.value="";
              if(mfgNode) mfgNode.value="";
              if(expNode) expNode.value="";
              if(qtyNode) qtyNode.focus();
            },0);
          }catch(err){
            toast(err?.message||'Failed to save entry');
          }finally{
            saveBtn.disabled=false;
          }
        }
      };
    }
    const deleteBtn=document.querySelector(`#${key}_delete`);
    if(deleteBtn){
      deleteBtn.onclick=async()=>{
        if(!canEditEntry){ toast("You do not have permission to delete this entry."); return; }
        const entry=state.lines.find(l=>l.id===editItemId[key]);
        if(!entry){ toast("Entry not found"); return; }
        const ok=await confirmDialog("Delete this entry?");
        if(!ok) return;
        try{
          deleteBtn.disabled=true;
          await api.delete(`/entries/${encodeURIComponent(entry.id)}`);
          await refreshEntries(type);
          addPanel[key]=false;
          editItemId[key]="";
          renderEntryPage(type);
          toast("Entry deleted");
        }catch(err){
          deleteBtn.disabled=false;
          toast(err?.message||'Failed to delete entry');
        }
      };
    }
  }
  else{
    cleanupItemPicker(key);
  }

  // Table paint with grouped numbering + totals; respects sub/location filters
  function attachSelectAllHandler(ids){
    const hdr=document.querySelector(`#selAll_${key}`); if(!hdr) return;
    hdr.checked=ids.length>0 && ids.every(id=>bulkSelected[key].has(id));
    hdr.indeterminate=ids.some(id=>bulkSelected[key].has(id)) && !hdr.checked;
    hdr.onchange=()=>{
      const check=hdr.checked;
      $$('[data-sel]', document.querySelector(`#${key}_body`)).forEach(cb=>{
        cb.checked=check;
        const id=cb.getAttribute("data-sel");
        if(check) bulkSelected[key].add(id); else bulkSelected[key].delete(id);
      });
    };
  }

  const paint=()=>{
    const q=document.querySelector(`#${key}_search`).value.trim().toLowerCase();
    const locFilter=flt[key].loc||"";
    const sub=flt[key].sub||"";
    const rows=linesAll
      .filter(l=>{
        if(q && !l.itemName.toLowerCase().includes(q)) return false;
        if(locFilter && l.locationId!==locFilter) return false;
        if(sub && l.categoryLabel!==sub) return false;
        return true;
      })
      .sort((a,b)=>{
        const A=(a.itemName+"|"+a.categoryLabel).localeCompare(b.itemName+"|"+b.categoryLabel); if(A!==0) return A;
        const c=(a.createdAt||"").localeCompare(b.createdAt||""); if(c!==0) return c;
        return (a.batch||"").localeCompare(b.batch||"");
      });

    const groups={}; rows.forEach(r=>{ const k=r.itemName+"|"+r.categoryLabel; (groups[k] ||= []).push(r); });
    const keys=Object.keys(groups).sort((a,b)=>a.localeCompare(b));
    let n=0, html="", manageableIds=[];
    keys.forEach(k=>{
      const arr=groups[k];
      n++;
      const totalQty=arr.reduce((t,x)=>t+x.qty,0);
      const unit=arr[0]?.unit||"";
      // Check if scope allows managing all entries or just own
      const scopeKey = key; // raw, sfg, fg
      const scopeValue = state.shareScopes?.[scopeKey] || 'own';
      const canManageAllEntries = scopeValue === 'org';
      arr.forEach((r,i)=>{
        const isLast=i===arr.length-1;
        const canManageEntry = canManageAllEntries || r.userId === state.currentUserId;
        if (canManageEntry) {
          manageableIds.push(r.id);
        } else {
          bulkSelected[key].delete(r.id);
        }
        const actionCell = (canBulkDelete && bulkMode[key])
          ? (canManageEntry
              ? `<input type="checkbox" data-sel="${H(r.id)}" class="h-4 w-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500" ${bulkSelected[key].has(r.id)?"checked":""}/>`
              : '<span class="text-xs text-slate-400">—</span>')
          : (canEditEntry && canManageEntry
              ? `<button class="p-1.5 rounded-md text-slate-500 hover:bg-slate-200" title="Edit" data-edit="${H(r.id)}">✎</button>`
              : '<span class="text-xs text-slate-400">—</span>');
        const highlightClass = getEntryHighlightClass(r.id);
        html+=`
          <tr class="hover:bg-slate-50 transition-colors${highlightClass}">
            <td class="px-4 py-2.5 border-t border-slate-200 text-right text-slate-500">${i===0?n:""}</td>
            <td class="px-4 py-2.5 border-t border-slate-200 text-slate-600">${H(r.createdBy||"")}</td>
            <td class="px-4 py-2.5 border-t border-slate-200 font-medium">${H(r.itemName)}</td>
            <td class="px-4 py-2.5 border-t border-slate-200 text-slate-500">${H(r.categoryLabel)}</td>
            <td class="px-4 py-2.5 border-t border-slate-200 text-slate-500 tracking-[0.08em] uppercase">${H(r.batch)}</td>
            ${showMfgExp?`
            <td class="px-4 py-2.5 border-t border-slate-200 text-slate-500 whitespace-nowrap tracking-[0.05em]">${H(r.mfg||"")}</td>
            <td class="px-4 py-2.5 border-t border-slate-200 text-slate-500 whitespace-nowrap tracking-[0.05em]">${H(r.exp||"")}</td>
            `:""}
            <td class="px-4 py-2.5 border-t border-slate-200 text-right font-medium">${r.qty} ${H(r.unit)}</td>
            <td class="px-4 py-2.5 border-t border-slate-200 text-slate-500">${H(r.locationName||"")}</td>
            <td class="px-4 py-2.5 border-t border-slate-200 text-right font-semibold">${isLast?`${totalQty} ${H(unit)}`:""}</td>
            <td class="px-4 py-2.5 border-t border-slate-200 text-right">
              ${actionCell}
            </td>
          </tr>`;
      });
    });

    document.querySelector(`#${key}_body`).innerHTML=html;
    if(canEditEntry){
      $$('[data-edit]').forEach(b=>b.onclick=()=>{ editItemId[key]=b.getAttribute("data-edit"); addPanel[key]=true; renderEntryPage(type); });
    }
    if(canBulkDelete){
      $$('[data-sel]').forEach(cb=>cb.onchange=()=>{ const id=cb.getAttribute("data-sel"); if(cb.checked) bulkSelected[key].add(id); else bulkSelected[key].delete(id); attachSelectAllHandler(manageableIds); });
      attachSelectAllHandler(manageableIds);
    }
  };
  document.querySelector(`#${key}_search`).oninput=paint;
  paint();
}
const renderRawPage=()=>renderEntryPage('RAW');
const renderSFGPage=()=>renderEntryPage('SFG');
const renderFGPage=()=>renderEntryPage('FG');

/* ============== Manage Data (unchanged; now also covers Raw subs) ============== */
function renderManagePage(){
  const page=$("#page");
  const canEditManage=!!state.permissions?.can_view_manage_data;
  page.innerHTML=`
    <h1 class="text-2xl md:text-3xl font-bold text-slate-900 mb-4">Manage Data</h1>
    <div class="border-b border-slate-200 mb-6">
      <nav class="-mb-px flex space-x-6" aria-label="Tabs">
        ${["categories","subcategories","locations","metrics"].map(tab=>{
          const labels={categories:"Groups",subcategories:"Sub-categories",locations:"Locations",metrics:"Metrics"};
          const label=labels[tab]||tab;
          const active = ui.manageTab===tab;
          return `<button data-tab="${H(tab)}" class="manage-tab whitespace-nowrap py-3 px-1 border-b-2 font-medium text-sm
                     ${active?'border-cyan-600 text-cyan-700':'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'}">${label}</button>`;
        }).join("")}
      </nav>
    </div>
    <div id="manage-content"></div>
  `;
  $$('.manage-tab').forEach(tab=>tab.onclick=()=>{ ui.manageTab=tab.dataset.tab; renderManagePage(); });

  const content=$('#manage-content');
  if(ui.manageTab==='categories'){
    const existingGroupNames = new Set((state.categoryGroups||[]).map(group=>group.name));
    content.innerHTML=`
      <div class="bg-white border border-slate-200 rounded-xl shadow-sm p-6 max-w-2xl">
        <h3 class="text-slate-900 font-semibold text-lg mb-3">Inventory Groups</h3>
        <p class="text-sm text-slate-500 mb-4">These core groups are managed by the system and cannot be changed.</p>
        <ul class="space-y-2">
          ${CORE_GROUP_NAMES.map((name)=>`
            <li class="flex items-center gap-3 text-sm font-medium text-slate-700">
              <span class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-cyan-50 text-cyan-600 font-semibold">${name.split(' ').map(part=>part[0]||'').join('').slice(0,2)}</span>
              <span>${H(name)}${existingGroupNames.has(name)?"":" <span class='text-xs font-medium text-amber-600'>(missing in database)</span>"}</span>
            </li>
          `).join("")}
        </ul>
      </div>`;
    return;
  }else if(ui.manageTab==='subcategories'){
    const addSection = canEditManage
      ? `<div>
          <h3 class="text-slate-900 font-semibold text-lg mb-3">Add Sub-category</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-sm font-medium text-slate-600 mb-1">Parent Group</label>
              <select id="sub_parent" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none"></select>
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-600 mb-1">New Sub-category Name</label>
              <div class="flex items-center gap-2">
                <input id="sub_new" placeholder="" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none"/>
                <button id="sub_add" class="px-4 h-9 text-sm rounded-lg font-semibold text-white bg-cyan-600 hover:bg-cyan-700">Add</button>
              </div>
            </div>
          </div>
        </div>`
      : `<div class="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">
          You do not have permission to modify sub-categories.
        </div>`;
    const listHeader = canEditManage ? "Edit Sub-categories" : "Sub-categories";
    const listHint = canEditManage ? "" : '<p class="text-sm text-slate-500 mb-3">Read-only view.</p>';
    content.innerHTML=`
      <div class="bg-white border border-slate-200 rounded-xl shadow-sm p-6 max-w-2xl">
        ${addSection}
        <div class="mt-8">
          <h3 class="text-slate-900 font-semibold text-lg mb-3">${listHeader}</h3>
          ${listHint}
          <div id="sub_list" class="space-y-2"></div>
        </div>
      </div>`;
    paintSubs();
    if(canEditManage){
      const addBtn=$("#sub_add");
      if(addBtn) addBtn.onclick=async()=>{
        const parent=$("#sub_parent").value;
        const name=$("#sub_new").value.trim();
        if(!parent||!name){ toast("Parent group and name required"); return; }
        const exists=state.subcategories.some(sub=>sub.group_id===parent && sub.name.toLowerCase()===name.toLowerCase());
        if(exists){ toast("Sub-category already exists"); return; }
        try{
          addBtn.disabled=true;
          await api.post('/categories/subs', {name, group_id:parent});
          $("#sub_new").value="";
          await refreshCategoryData();
          await refreshItems();
          renderManagePage();
          toast("Sub-category added");
        }catch(err){
          toast(err?.message||'Failed to add sub-category');
        }finally{
          addBtn.disabled=false;
        }
      };
    }
  }else if(ui.manageTab==='locations'){
    const addLocationSection = canEditManage
      ? `<div>
          <h3 class="text-slate-900 font-semibold text-lg mb-2">Add Location</h3>
          <div class="flex items-center gap-2">
            <input id="loc_new" placeholder="" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none"/>
            <button id="loc_add" class="px-4 h-9 text-sm rounded-lg font-semibold text-white bg-cyan-600 hover:bg-cyan-700">Add</button>
          </div>
        </div>`
      : `<div class="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">You do not have permission to manage locations.</div>`;
    const locationHeader = canEditManage ? "Edit Locations" : "Locations";
    const locationHint = canEditManage ? "" : '<p class="text-sm text-slate-500 mb-3">Read-only view.</p>';
    content.innerHTML=`
      <div class="bg-white border border-slate-200 rounded-xl shadow-sm p-6 max-w-2xl">
        ${addLocationSection}
        <div class="mt-8">
          <h3 class="text-slate-900 font-semibold text-lg mb-3">${locationHeader}</h3>
          ${locationHint}
          <div id="loc_list" class="space-y-2"></div>
        </div>
      </div>`;
    paintLocations();
    if(canEditManage){
      const addLocBtn=$("#loc_add");
      if(addLocBtn) addLocBtn.onclick=async()=>{
        const input=$("#loc_new");
        const name=input.value.trim();
        if(!name){ toast("Location name is required"); return; }
        if(state.locations.some(loc=>loc.name.toLowerCase()===name.toLowerCase())){ toast("Location already exists"); return; }
        try{
          addLocBtn.disabled=true;
          await api.post('/warehouses/', {name});
          input.value="";
          await refreshLocations();
          renderManagePage();
          toast("Location added");
        }catch(err){
          toast(err?.message||'Failed to add location');
        }finally{
          addLocBtn.disabled=false;
        }
      };
    }
  }else if(ui.manageTab==='metrics'){
    const addMetricSection = canEditManage
      ? `<div>
          <h3 class="text-slate-900 font-semibold text-lg mb-2">Add Metric</h3>
          <div class="flex items-center gap-2">
            <input id="met_new" placeholder="" class="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-cyan-500 outline-none"/>
            <button id="met_add" class="px-4 h-9 text-sm rounded-lg font-semibold text-white bg-cyan-600 hover:bg-cyan-700">Add</button>
          </div>
        </div>`
      : `<div class="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">You do not have permission to manage metrics.</div>`;
    const metricHeader = canEditManage ? "Edit Metrics" : "Metrics";
    const metricHint = canEditManage ? "" : '<p class="text-sm text-slate-500 mb-3">Read-only view.</p>';
    content.innerHTML=`
      <div class="bg-white border border-slate-200 rounded-xl shadow-sm p-6 max-w-2xl">
        ${addMetricSection}
        <div class="mt-8">
          <h3 class="text-slate-900 font-semibold text-lg mb-3">${metricHeader}</h3>
          ${metricHint}
          <div id="met_list" class="space-y-2"></div>
        </div>
      </div>`;
    paintMetrics();
    if(canEditManage){
      const addMetricBtn=$("#met_add");
      if(addMetricBtn) addMetricBtn.onclick=async()=>{
        const input=$("#met_new");
        const name=input.value.trim();
        if(!name){ toast("Metric name is required"); return; }
        if(state.metricEntities.some(m=>m.name.toLowerCase()===name.toLowerCase())){ toast("Metric already exists"); return; }
        try{
          addMetricBtn.disabled=true;
          await api.post('/metrics/', {name});
          input.value="";
          await refreshMetrics();
          paintMetrics();
          toast("Metric added");
        }catch(err){
          toast(err?.message||'Failed to add metric');
        }finally{
          addMetricBtn.disabled=false;
        }
      };
    }
  }
}
function paintSubs(){
  const parentSelect=$("#sub_parent");
  const groups=Array.isArray(state.categoryGroups)?state.categoryGroups:[];
  if(parentSelect){
    parentSelect.innerHTML=groups.map(group=>`<option value="${H(group.id)}">${H(group.name)}</option>`).join("");
    if(!groups.length){
      parentSelect.innerHTML='<option value="">No groups available</option>';
    }
  }
  const list=$("#sub_list");
  if(!list) return;
  const subs=Array.isArray(state.subcategories)?state.subcategories:[];
    const canEdit=!!state.permissions?.can_view_manage_data;
  if(!canEdit){
    ui.editItemId.manage_sub="";
  }
  if(!subs.length){
    list.innerHTML=`<div class="text-slate-400 text-sm text-center py-4">No sub-categories found.</div>`;
    return;
  }
  list.innerHTML=subs.map(sub=>{
    const groupName=state.categoryMeta?.groupIdToName?.get(sub.group_id) || "";
    const editing=ui.editItemId.manage_sub===sub.id;
    const slugId=slug(sub.id);
    if(!canEdit){
      return `
        <div class="flex items-center gap-2 text-sm p-2 rounded-lg">
          <div class="w-1/3 text-sm text-slate-500 truncate px-2" title="${H(groupName)}">${H(groupName)}</div>
          <div class="flex-grow font-medium text-slate-700 px-2 py-1.5">${H(sub.name)}</div>
        </div>`;
    }
    return `
      <div class="flex items-center gap-2 text-sm p-2 rounded-lg hover:bg-slate-50">
        ${editing?`
          <select id="sub-parent-${slugId}" class="w-1/3 bg-white border border-cyan-400 rounded-md px-2 py-1.5 text-sm outline-none">
            ${groups.map(group=>`<option value="${H(group.id)}" ${group.id===sub.group_id?'selected':''}>${H(group.name)}</option>`).join("")}
          </select>
          <input id="sub-name-${slugId}" value="${H(sub.name)}" class="flex-grow bg-white border border-cyan-400 rounded-md px-3 py-1.5 outline-none"/>
          <button class="p-2 rounded-md text-green-600 hover:bg-green-100" title="Confirm" data-confirm-sub="${H(sub.id)}">${ICONS.confirm}</button>
          <button class="p-2 rounded-md text-slate-500 hover:bg-slate-100" title="Cancel" data-cancel-sub>✕</button>
        `:`
          <div class="w-1/3 text-sm text-slate-500 truncate px-2" title="${H(groupName)}">${H(groupName)}</div>
          <div class="flex-grow font-medium text-slate-700 px-2 py-1.5">${H(sub.name)}</div>
          <button class="p-2 rounded-md text-slate-500 hover:bg-slate-200" title="Edit" data-edit-sub="${H(sub.id)}">${ICONS.edit}</button>
          <button class="p-2 rounded-md text-red-500 hover:bg-red-100" title="Delete" data-del-sub="${H(sub.id)}">${ICONS.trash}</button>
        `}
      </div>`;
  }).join("");
  if(canEdit){
    $$('[data-edit-sub]').forEach(btn=>btn.onclick=()=>{ ui.editItemId.manage_sub=btn.dataset.editSub; paintSubs(); });
    $$('[data-cancel-sub]').forEach(btn=>btn.onclick=()=>{ ui.editItemId.manage_sub=""; paintSubs(); });
    $$('[data-confirm-sub]').forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.confirmSub;
      const sub=state.subcategories.find(s=>s.id===id);
      if(!sub) return;
      const input=document.getElementById(`sub-name-${slug(sub.id)}`);
      const parentSelectEl=document.getElementById(`sub-parent-${slug(sub.id)}`);
      const newName=input?input.value.trim():"";
      const newParent=parentSelectEl?parentSelectEl.value:sub.group_id;
      if(!newName){ toast("Sub-category name is required"); return; }
      const duplicate=state.subcategories.some(s=>s.id!==id && s.group_id===newParent && s.name.toLowerCase()===newName.toLowerCase());
      if(duplicate){ toast("Sub-category already exists"); return; }
      try{
        await api.put(`/categories/subs/${encodeURIComponent(id)}`, {name:newName, group_id:newParent});
        ui.editItemId.manage_sub="";
        await refreshCategoryData();
        await refreshItems();
        applyCategoryUpdateToEntries(id);
        renderManagePage();
        toast("Sub-category updated");
      }catch(err){
        toast(err?.message||'Failed to update sub-category');
      }
    });
    $$('[data-del-sub]').forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.delSub;
      const sub=state.subcategories.find(s=>s.id===id);
      if(!sub) return;
      const hasItems=state.items.some(item=>item.categoryId===id);
      if(hasItems){ toast("Cannot delete. Items are linked to this sub-category"); return; }
      const hasEntries=state.lines.some(line=>line.categoryId===id);
      if(hasEntries){ toast("Cannot delete. Entries exist for this sub-category"); return; }
      const ok=await confirmDialog(`Delete "${sub.name}"?`);
      if(!ok) return;
      try{
        await api.delete(`/categories/subs/${encodeURIComponent(id)}`);
        await refreshCategoryData();
        await refreshItems();
        renderManagePage();
        toast("Sub-category deleted");
      }catch(err){
        toast(err?.message||'Failed to delete sub-category');
      }
    });
  }
}

function paintLocations(){
  const list=$("#loc_list"); if(!list) return;
  const locations=Array.isArray(state.locations)?state.locations:[];
    const canEdit=!!state.permissions?.can_view_manage_data;
  if(!canEdit){
    ui.editItemId.manage_loc="";
  }
  if(!locations.length){
    list.innerHTML=`<div class="text-slate-400 text-sm text-center py-4">No locations found.</div>`;
    return;
  }
  list.innerHTML=locations.map(loc=>{
    const editing=ui.editItemId.manage_loc===loc.id;
    const slugId=slug(loc.id);
    if(!canEdit){
      return `
        <div class="flex items-center gap-2 text-sm p-2 rounded-lg">
          <div class="flex-grow font-medium text-slate-700 px-2 py-1.5">${H(loc.name)}</div>
        </div>`;
    }
    return `
      <div class="flex items-center gap-2 text-sm p-2 rounded-lg hover:bg-slate-50">
        ${editing?`
          <input id="loc-edit-${slugId}" value="${H(loc.name)}" class="flex-grow bg-white border border-cyan-400 rounded-md px-3 py-1.5 outline-none"/>
          <button class="p-2 rounded-md text-green-600 hover:bg-green-100" title="Confirm" data-confirm-loc="${H(loc.id)}">${ICONS.confirm}</button>
          <button class="p-2 rounded-md text-slate-500 hover:bg-slate-100" title="Cancel" data-cancel-loc>✕</button>
        `:`
          <div class="flex-grow font-medium text-slate-700 px-2 py-1.5">${H(loc.name)}</div>
          <button class="p-2 rounded-md text-slate-500 hover:bg-slate-200" title="Edit" data-edit-loc="${H(loc.id)}">${ICONS.edit}</button>
          <button class="p-2 rounded-md text-red-500 hover:bg-red-100" title="Delete" data-del-loc="${H(loc.id)}">${ICONS.trash}</button>
        `}
      </div>`;
  }).join("");
  if(canEdit){
    $$('[data-edit-loc]').forEach(btn=>btn.onclick=()=>{ ui.editItemId.manage_loc=btn.dataset.editLoc; paintLocations(); });
    $$('[data-cancel-loc]').forEach(btn=>btn.onclick=()=>{ ui.editItemId.manage_loc=""; paintLocations(); });
    $$('[data-confirm-loc]').forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.confirmLoc;
      const loc=state.locations.find(l=>l.id===id);
      if(!loc) return;
      const input=document.getElementById(`loc-edit-${slug(loc.id)}`);
      const newName=input?input.value.trim():"";
      if(!newName||newName===loc.name){ ui.editItemId.manage_loc=""; paintLocations(); return; }
      if(state.locations.some(other=>other.id!==id && other.name.toLowerCase()===newName.toLowerCase())){ toast("Location already exists"); return; }
      try{
        await api.put(`/warehouses/${encodeURIComponent(id)}`, {name:newName});
        ui.editItemId.manage_loc="";
        await refreshLocations();
        const updatedLocation=lookupLocationById(id);
        if(updatedLocation) applyLocationToEntries(updatedLocation);
        renderManagePage();
        toast("Location updated");
      }catch(err){
        toast(err?.message||'Failed to update location');
      }
    });
    $$('[data-del-loc]').forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.delLoc;
      if(state.locations.length<=1){ toast("At least one location is required"); return; }
      const hasEntries=state.lines.some(line=>line.locationId===id);
      if(hasEntries){ toast("Cannot delete. Entries exist in this location"); return; }
      const ok=await confirmDialog("Delete this location?");
      if(!ok) return;
      try{
        await api.delete(`/warehouses/${encodeURIComponent(id)}`);
        await refreshLocations();
        renderManagePage();
        toast("Location deleted");
      }catch(err){
        toast(err?.message||'Failed to delete location');
      }
    });
  }
}

function paintMetrics(){
  const container=$("#met_list"); if(!container) return;
  const metrics=Array.isArray(state.metricEntities)?state.metricEntities.slice().sort((a,b)=>a.name.localeCompare(b.name)):[];
  if(ui.editItemId.manage_metric && !metrics.some(m=>m.id===ui.editItemId.manage_metric)){
    ui.editItemId.manage_metric="";
  }
    const canEdit=!!state.permissions?.can_view_manage_data;
  if(!canEdit){
    ui.editItemId.manage_metric="";
  }
  if(!metrics.length){
    container.innerHTML=`<div class="text-slate-400 text-sm text-center py-4">No metrics found.</div>`;
    return;
  }
  container.innerHTML=metrics.map(metric=>{
    const editing=ui.editItemId.manage_metric===metric.id;
    const slugId=slug(metric.id);
    if(!canEdit){
      return `
        <div class="flex items-center gap-2 text-sm p-2 rounded-lg">
          <div class="flex-grow font-medium text-slate-700 px-2 py-1.5">${H(metric.name)}</div>
        </div>`;
    }
    return `
      <div class="flex items-center gap-2 text-sm p-2 rounded-lg hover:bg-slate-50">
        ${editing?`
          <input id="met-edit-${slugId}" value="${H(metric.name)}" class="flex-grow bg-white border border-cyan-400 rounded-md px-3 py-1.5 outline-none"/>
          <button class="p-2 rounded-md text-green-600 hover:bg-green-100" title="Confirm" data-confirm-metric="${H(metric.id)}">${ICONS.confirm}</button>
          <button class="p-2 rounded-md text-slate-500 hover:bg-slate-100" title="Cancel" data-cancel-metric>✕</button>
        `:`
          <div class="flex-grow font-medium text-slate-700 px-2 py-1.5">${H(metric.name)}</div>
          <button class="p-2 rounded-md text-slate-500 hover:bg-slate-200" title="Edit" data-edit-metric="${H(metric.id)}">${ICONS.edit}</button>
          <button class="p-2 rounded-md text-red-500 hover:bg-red-100" title="Delete" data-del-metric="${H(metric.id)}" data-metric-name="${H(metric.name)}">${ICONS.trash}</button>
        `}
      </div>`;
  }).join("");
  if(canEdit){
    $$('[data-edit-metric]').forEach(btn=>btn.onclick=()=>{ ui.editItemId.manage_metric=btn.dataset.editMetric; paintMetrics(); });
    $$('[data-cancel-metric]').forEach(btn=>btn.onclick=()=>{ ui.editItemId.manage_metric=""; paintMetrics(); });
    $$('[data-confirm-metric]').forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.confirmMetric;
      const metric=state.metricEntities.find(m=>m.id===id);
      if(!metric) return;
      const input=document.getElementById(`met-edit-${slug(metric.id)}`);
      const newName=input?input.value.trim():"";
      if(!newName||newName===metric.name){ ui.editItemId.manage_metric=""; paintMetrics(); return; }
      if(state.metricEntities.some(m=>m.id!==id && m.name.toLowerCase()===newName.toLowerCase())){ toast("Metric already exists"); return; }
      try{
        await api.put(`/metrics/${encodeURIComponent(id)}`, {name:newName});
        ui.editItemId.manage_metric="";
        await refreshMetrics();
        paintMetrics();
        toast("Metric updated");
      }catch(err){
        toast(err?.message||'Failed to update metric');
      }
    });
    $$('[data-del-metric]').forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.delMetric;
      const metric=state.metricEntities.find(m=>m.id===id);
      if(!metric) return;
      const lower=metric.name.toLowerCase();
      if(state.items.some(it=>String(it.unit||"").toLowerCase()===lower)){ toast("Cannot delete. Items use this metric"); return; }
      if(state.lines.some(line=>String(line.unit||"").toLowerCase()===lower)){ toast("Cannot delete. Entries use this metric"); return; }
      const ok=await confirmDialog(`Delete metric "${metric.name}"?`);
      if(!ok) return;
      try{
        await api.delete(`/metrics/${encodeURIComponent(id)}`);
        await refreshMetrics();
        paintMetrics();
        toast("Metric deleted");
      }catch(err){
        toast(err?.message||'Failed to delete metric');
      }
    });
  }
}

/* ============== Router & Toast ============== */
function renderRoute(){
  if(route==="dashboard") return renderDashboard();
  if(route==="add") return renderAddPage();
  if(route==="raw") return renderRawPage();
  if(route==="sfg") return renderSFGPage();
  if(route==="fg") return renderFGPage();
  if(route==="manage") return renderManagePage();
  if(route==="users") return renderUsersPage();
}
let toastT=null;
let toastEl=null;
function toast(msg){
  // Create toast element dynamically and append to body for proper z-index stacking
  if(!toastEl){
    toastEl=document.createElement('div');
    toastEl.id='toastGlobal';
    toastEl.className='fixed bottom-5 right-5 hidden bg-slate-900 text-white rounded-xl px-4 py-2.5 shadow-lg font-semibold text-sm';
    toastEl.style.zIndex='99999';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent=msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastT);
  toastT=setTimeout(()=>toastEl.classList.add("hidden"),3000);
}

function syncHistory(){
  if(typeof window === "undefined") return;
  const target=ROUTE_PATHS[route] || ROUTE_PATHS.dashboard || "/dashboard";
  if(window.location.pathname !== target){
    window.history.replaceState(null,"",target);
  }
}
let exportDialogKeyHandler=null;
function showDashboardExportDialog(){
  const overlay=$("#exportOverlay");
  if(!overlay) return;
  const form=overlay.querySelector('#exportForm');
  const canWithMaster = !!state.permissions?.can_export_dashboard_summary;
  const canValuated = !!state.permissions?.can_export_dashboard_entries;
  const masterInput = form ? form.querySelector('input[name="exportMode"][value="with-master"]') : null;
  const valuatedInput = form ? form.querySelector('input[name="exportMode"][value="valuated"]') : null;
  if(masterInput){
    const label = masterInput.closest('label');
    if(label) label.classList.toggle('hidden', !canWithMaster);
    masterInput.disabled = !canWithMaster;
    if(!canWithMaster) masterInput.checked = false;
  }
  if(valuatedInput){
    const label = valuatedInput.closest('label');
    if(label) label.classList.toggle('hidden', !canValuated);
    valuatedInput.disabled = !canValuated;
    if(!canValuated) valuatedInput.checked = false;
  }
  if(!canWithMaster && !canValuated){
    toast('You do not have permission to export data.');
    return;
  }
  if(form && !form.querySelector('input[name="exportMode"]:checked')){
    const first=form.querySelector('input[name="exportMode"]');
    if(first) first.checked=true;
  }
  overlay.classList.add('show');
  const body=document.body;
  if(body) body.classList.add('overflow-hidden');
  if(exportDialogKeyHandler){
    document.removeEventListener('keydown',exportDialogKeyHandler);
  }
  exportDialogKeyHandler=e=>{ if(e.key==='Escape') hideDashboardExportDialog(); };
  document.addEventListener('keydown',exportDialogKeyHandler);
}
function hideDashboardExportDialog(){
  const overlay=$("#exportOverlay");
  if(overlay){
    overlay.classList.remove('show');
  }
  const body=document.body;
  if(body) body.classList.remove('overflow-hidden');
  if(exportDialogKeyHandler){
    document.removeEventListener('keydown',exportDialogKeyHandler);
    exportDialogKeyHandler=null;
  }
  const submitBtn=$("#exportSubmit");
  if(submitBtn){
    submitBtn.disabled=false;
    submitBtn.textContent=submitBtn.dataset.defaultLabel||'Export';
    delete submitBtn.dataset.loading;
  }
}
let confirmResolver=null;
let confirmKeyHandler=null;
function resolveConfirm(result){
  const overlay=$("#confirmOverlay");
  if(overlay){
    overlay.classList.remove("show");
  }
  const body=document.body;
  if(body) body.classList.remove("overflow-hidden");
  if(confirmKeyHandler){
    document.removeEventListener('keydown',confirmKeyHandler);
    confirmKeyHandler=null;
  }
  if(confirmResolver){
    const resolver=confirmResolver;
    confirmResolver=null;
    resolver(Boolean(result));
  }
}
function confirmDialog(message){
  // Ensure the confirm overlay exists; inject if missing
  let overlay=$("#confirmOverlay");
  if(!overlay){
    const html=`
      <div id="confirmOverlay" class="modal-overlay">
        <div class="modal-card" style="max-width:400px;">
          <div class="modal-header">
            <h2 class="modal-title">Confirm</h2>
          </div>
          <div class="modal-body">
            <p id="confirmMessage" class="text-sm text-slate-600"></p>
          </div>
          <div class="modal-footer">
            <button id="confirmCancel" class="btn">Cancel</button>
            <button id="confirmOk" class="btn btn-primary">OK</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend",html);
    overlay=$("#confirmOverlay");
    const cancelBtn=$("#confirmCancel");
    const okBtn=$("#confirmOk");
    const backdrop=overlay;
    if(cancelBtn) cancelBtn.onclick=()=>resolveConfirm(false);
    if(okBtn) okBtn.onclick=()=>resolveConfirm(true);
    if(backdrop) backdrop.onclick=(e)=>{if(e.target===backdrop)resolveConfirm(false);};
  }
  const messageEl=$("#confirmMessage");
  if(!overlay||!messageEl) return Promise.resolve(false);
  messageEl.textContent=message;
  overlay.classList.add("show");
  const body=document.body;
  if(body) body.classList.add("overflow-hidden");
  return new Promise(resolve=>{
    confirmResolver=resolve;
    if(confirmKeyHandler){
      document.removeEventListener('keydown',confirmKeyHandler);
    }
    confirmKeyHandler=e=>{
      if(e.key==='Escape') resolveConfirm(false);
      if(e.key==='Enter') resolveConfirm(true);
    };
    document.addEventListener('keydown',confirmKeyHandler);
  });
}

/* Custom Prompt Dialog (replaces native window.prompt) */
let promptResolver = null;
let promptKeyHandler = null;

function resolvePrompt(value) {
  const overlay = $("#promptOverlay");
  if (overlay) overlay.classList.remove("show");
  const body = document.body;
  if (body) body.classList.remove("overflow-hidden");
  if (promptKeyHandler) {
    document.removeEventListener("keydown", promptKeyHandler);
    promptKeyHandler = null;
  }
  if (promptResolver) {
    const resolver = promptResolver;
    promptResolver = null;
    resolver(value);
  }
}

function promptDialog(message, defaultValue = "") {
  // Ensure the prompt overlay exists; inject if missing
  let overlay = $("#promptOverlay");
  if (!overlay) {
    const html = `
      <div id="promptOverlay" class="modal-overlay">
        <div class="modal-card" style="max-width:400px;">
          <div class="modal-header">
            <h2 id="promptTitle" class="modal-title">Input</h2>
          </div>
          <div class="modal-body">
            <p id="promptMessage" class="text-sm text-slate-600 mb-3"></p>
            <input id="promptInput" type="text" class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent" />
          </div>
          <div class="modal-footer">
            <button id="promptCancel" class="btn">Cancel</button>
            <button id="promptOk" class="btn btn-primary">OK</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    overlay = $("#promptOverlay");
    const cancelBtn = $("#promptCancel");
    const okBtn = $("#promptOk");
    const backdrop = overlay;
    if (cancelBtn) cancelBtn.onclick = () => resolvePrompt(null);
    if (okBtn) okBtn.onclick = () => resolvePrompt($("#promptInput")?.value ?? null);
    if (backdrop) backdrop.onclick = (e) => { if (e.target === backdrop) resolvePrompt(null); };
  }

  const messageEl = $("#promptMessage");
  const inputEl = $("#promptInput");
  if (!overlay || !messageEl || !inputEl) return Promise.resolve(null);

  messageEl.textContent = message;
  inputEl.value = defaultValue;
  overlay.classList.add("show");
  const body = document.body;
  if (body) body.classList.add("overflow-hidden");

  // Focus input after a tick so it's visible
  setTimeout(() => {
    inputEl.focus();
    inputEl.select();
  }, 50);

  return new Promise((resolve) => {
    promptResolver = resolve;
    if (promptKeyHandler) {
      document.removeEventListener("keydown", promptKeyHandler);
    }
    promptKeyHandler = (e) => {
      if (e.key === "Escape") resolvePrompt(null);
      if (e.key === "Enter") resolvePrompt(inputEl.value);
    };
    document.addEventListener("keydown", promptKeyHandler);
  });
}

/* Custom Copy Dialog (for showing text to copy) */
function copyDialog(message, textToCopy) {
  // Ensure overlay exists
  let overlay = $("#copyOverlay");
  if (!overlay) {
    const html = `
      <div id="copyOverlay" class="modal-overlay">
        <div class="modal-card" style="max-width:500px;">
          <div class="modal-header">
            <h2 class="modal-title">Copy Link</h2>
          </div>
          <div class="modal-body">
            <p id="copyMessage" class="text-sm text-slate-600 mb-3"></p>
            <input id="copyInput" type="text" readonly class="w-full px-3 py-2 border border-slate-300 rounded-lg bg-slate-50 text-slate-700 font-mono text-sm" />
          </div>
          <div class="modal-footer">
            <button id="copyClose" class="btn">Close</button>
            <button id="copyBtn" class="btn btn-primary">Copy</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    overlay = $("#copyOverlay");
    const closeBtn = $("#copyClose");
    const copyBtn = $("#copyBtn");
    const backdrop = overlay;
    if (closeBtn) closeBtn.onclick = () => { overlay.classList.remove("show"); document.body.classList.remove("overflow-hidden"); };
    if (backdrop) backdrop.onclick = (e) => { if (e.target === backdrop) { overlay.classList.remove("show"); document.body.classList.remove("overflow-hidden"); } };
    if (copyBtn) copyBtn.onclick = async () => {
      const input = $("#copyInput");
      if (input) {
        try {
          await navigator.clipboard.writeText(input.value);
          toast("Copied to clipboard");
        } catch (_) {
          input.select();
          document.execCommand("copy");
          toast("Copied to clipboard");
        }
      }
    };
  }

  const messageEl = $("#copyMessage");
  const inputEl = $("#copyInput");
  if (!overlay || !messageEl || !inputEl) return;

  messageEl.textContent = message;
  inputEl.value = textToCopy;
  overlay.classList.add("show");
  document.body.classList.add("overflow-hidden");

  setTimeout(() => {
    inputEl.focus();
    inputEl.select();
  }, 50);
}

renderApp();
hydrateState();




