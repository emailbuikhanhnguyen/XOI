import { firebaseConfig } from "./firebase-config.js";
import {
  initializeApp, deleteApp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, addDoc, getDoc, getDocs,
  query, where, orderBy, limit, updateDoc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Bật lưu offline: chấm công / nhập kho / chuyển hàng vẫn lưu được khi mất
// mạng (ghi vào IndexedDB của trình duyệt), tự đồng bộ lên Firestore ngay
// khi có mạng lại — không cần chờ mạng mới thao tác được ở quầy.
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch (err) {
  // Trình duyệt/chế độ không hỗ trợ persistence (vd. một số trình duyệt ẩn
  // danh) → rơi về Firestore bình thường (chỉ hoạt động khi có mạng).
  console.error("Không bật được lưu offline, dùng chế độ online-only:", err);
  db = getFirestore(app);
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

/* ===================== MẠNG (online/offline) ===================== */
function updateNetworkBanner() {
  const el = document.getElementById("network-banner");
  if (!el) return;
  el.hidden = navigator.onLine;
}
window.addEventListener("online", () => { updateNetworkBanner(); toast("Đã có mạng lại — dữ liệu đang tự đồng bộ."); });
window.addEventListener("offline", () => { updateNetworkBanner(); toast("Mất mạng — vẫn thao tác bình thường, dữ liệu sẽ tự đồng bộ khi có mạng lại."); });

// Lưu 1 thao tác ghi Firestore kiểu "optimistic": khi đang mất mạng, promise
// của addDoc/updateDoc/setDoc sẽ treo tới lúc có mạng lại (đặc tính của
// Firestore offline persistence) — nên ở đây không chờ mà coi như đã lưu cục
// bộ ngay (dữ liệu đã nằm trong cache offline và sẽ tự đồng bộ), đồng thời
// vẫn bắt lỗi ngầm nếu cuối cùng ghi thất bại. Khi đang có mạng thì chờ bình
// thường như cũ để bắt lỗi (vd. sai quyền) ngay lúc đó.
async function saveOp(writePromiseFactory, onDone) {
  const p = writePromiseFactory();
  if (!navigator.onLine) {
    p.catch((err) => { console.error(err); toast("Đồng bộ thất bại: " + (err.message || "")); });
    if (onDone) await onDone(false);
    return;
  }
  try {
    await p;
    if (onDone) await onDone(true);
  } catch (err) {
    console.error(err);
    toast("Lỗi khi lưu: " + (err.message || "Thử lại nhé."));
  }
}

/* ===================== STATE ===================== */
let currentUser = null;
let profile = null; // { name, role, email, locationId }
let staffDirectory = {}; // uid -> {name, role, locationId, active, email}
let locationsDirectory = {}; // id -> {name, type: 'kitchen'|'point', address, giaBan, luongMacDinh, active}
let settings = { giaBan: 15000, luongMacDinh: 60000 }; // fallback mặc định khi 1 điểm chưa cấu hình
let editingEntryId = null;
let editingIngId = null;
let editingTransferId = null;
let editingLocationId = null;
let editingThuChiId = null;
let ingReceiptCtl = null; // control ảnh hoá đơn của form nhập nguyên liệu (gắn trong renderKho)
let tcReceiptCtl = null; // control ảnh hoá đơn của form thu chi (gắn trong renderThuChi)
let itemCatalog = {}; // itemName -> { unit, qtyPerPortion, threshold } — định mức & ngưỡng cảnh báo (settings/itemCatalog)
let entryListLimit = 30, ingListLimit = 30, trfListLimit = 30, tcListLimit = 30; // "Xem thêm" — tăng dần khi bấm

const STOCK_WINDOW_DAYS = 365; // khoảng thời gian dùng để tính tồn kho / lịch sử gần đây
const ITEM_SUGGESTIONS = ["Gà", "Nấm", "Gạo nếp", "Đậu xanh", "Dầu ăn", "Hành phi", "Gia vị", "Nước tương", "Túi/hộp gói"];
const THU_CHI_CATEGORIES = [
  "Doanh thu khác", "Tiền mặt bằng", "Điện nước", "Sửa chữa/bảo trì",
  "Marketing/quảng cáo", "Vận chuyển", "Dụng cụ/vật tư", "Thuế/phí", "Chi phí khác",
];

/* ===================== HELPERS ===================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const viewRoot = $("#view-root");

function fmt(n) { return Math.round(n || 0).toLocaleString("vi-VN") + "đ"; }
function fmtNum(n) { return (n || 0).toLocaleString("vi-VN"); }

function isoLocal(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayISO() { return isoLocal(new Date()); }
function addDays(dateStr, n) { const d = new Date(dateStr + "T00:00:00"); d.setDate(d.getDate() + n); return isoLocal(d); }
function mondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return isoLocal(d);
}
const WEEKDAY = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
function weekdayLabel(dateStr) { return WEEKDAY[new Date(dateStr + "T00:00:00").getDay()]; }
function formatDateVN(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return `${weekdayLabel(dateStr)}, ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function staffName(uid) { return staffDirectory[uid]?.name || "Không rõ"; }
function locationName(id) { return locationsDirectory[id]?.name || (id ? "(điểm đã xoá)" : "Chưa gán điểm"); }
function locationGiaBan(id) { return locationsDirectory[id]?.giaBan ?? settings.giaBan ?? 0; }
function isAdmin() { return profile?.role === "admin"; }
function myLocation() { return locationsDirectory[profile?.locationId] || null; }
function activeLocations() { return Object.entries(locationsDirectory).filter(([, l]) => l.active !== false); }
function kitchenLocations() { return activeLocations().filter(([, l]) => l.type === "kitchen"); }
function pointLocations() { return activeLocations().filter(([, l]) => l.type === "point"); }

// Điểm bếp mà người dùng hiện tại thao tác nhập/xuất kho (mặc định điểm đầu tiên nếu là admin)
function operatingKitchenId() {
  if (myLocation()?.type === "kitchen") return profile.locationId;
  const list = kitchenLocations();
  return list.length ? list[0][0] : null;
}
function isKitchenContext() { return isAdmin() || myLocation()?.type === "kitchen"; }

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ===================== ẢNH HOÁ ĐƠN ===================== */
// Không dùng Firebase Storage (từ 09/2024 Storage mặc định yêu cầu gói Blaze
// trả phí) — thay vào đó nén ảnh nhỏ lại rồi lưu thẳng dạng base64 trong
// document Firestore (đủ nhỏ để không vượt giới hạn 1MB/document).
function compressImageToDataUrl(file, maxDim = 900, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Không đọc được ảnh"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Không đọc được ảnh"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Gắn 1 input[type=file] ảnh hoá đơn vào 1 form: nén ảnh khi chọn, hiện
// preview nhỏ, cho xoá. Trả về { get, set } để form đọc/đặt giá trị hiện tại.
function wireReceiptInput(inputId, rowId, imgId, clearBtnId) {
  const inputEl = $("#" + inputId);
  const rowEl = $("#" + rowId);
  const imgEl = $("#" + imgId);
  const clearBtn = $("#" + clearBtnId);
  if (!inputEl) return { get: () => "", set: () => {} };
  let current = "";
  function render() {
    if (current) { imgEl.src = current; rowEl.hidden = false; } else { rowEl.hidden = true; imgEl.src = ""; }
  }
  inputEl.addEventListener("change", async () => {
    const file = inputEl.files && inputEl.files[0];
    inputEl.value = "";
    if (!file) return;
    try {
      current = await compressImageToDataUrl(file);
      render();
    } catch (err) {
      console.error(err);
      toast("Không đọc được ảnh, thử ảnh khác nhé");
    }
  });
  clearBtn?.addEventListener("click", () => { current = ""; render(); });
  return { get: () => current, set: (url) => { current = url || ""; render(); } };
}

function receiptThumbHtml(url) {
  return url ? `<img class="receipt-thumb" src="${url}" data-lightbox="1" alt="Ảnh hoá đơn" />` : "";
}

function openLightbox(src) {
  const el = document.createElement("div");
  el.className = "receipt-lightbox";
  el.innerHTML = `<img src="${src}" alt="Ảnh hoá đơn" />`;
  el.addEventListener("click", () => el.remove());
  document.body.appendChild(el);
}

// true nếu 1 trong các field của row (đọc từ fields, vd ["itemName","ghiChu"])
// chứa chuỗi tìm kiếm (không phân biệt hoa/thường, không dấu-sensitive).
function matchesSearch(row, term, fields) {
  if (!term) return true;
  const t = term.toLowerCase();
  return fields.some((f) => (row[f] || "").toString().toLowerCase().includes(t));
}

function emptyState(msg) {
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 3h14l-1 6a6 6 0 0 1-12 0L5 3Z"/><path d="M9 21h6M12 15v6"/></svg>
    <div>${msg}</div>
  </div>`;
}

/* ===================== AUTH ===================== */
$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  const errEl = $("#login-error");
  errEl.hidden = true;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    errEl.textContent = "Sai email hoặc mật khẩu. Vui lòng thử lại.";
    errEl.hidden = false;
  }
});

$("#btn-logout").addEventListener("click", () => signOut(auth));

$("#btn-forgot-password").addEventListener("click", async () => {
  const email = ($("#login-email").value || "").trim();
  if (!email) { toast("Nhập email của bạn ở ô Email trước, rồi bấm Quên mật khẩu lần nữa"); return; }
  try {
    await sendPasswordResetEmail(auth, email);
    toast("Đã gửi email đặt lại mật khẩu tới " + email + " (kiểm tra cả mục thư rác)");
  } catch (err) {
    console.error(err);
    toast("Không gửi được email. Kiểm tra lại email đã nhập.");
  }
});

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (!snap.exists()) {
        toast("Tài khoản chưa được thiết lập hồ sơ. Liên hệ chủ quán.");
        await signOut(auth);
        return;
      }
      profile = snap.data();
      await Promise.all([loadStaffDirectory(), loadLocationsDirectory(), loadSettings(), loadItemCatalog()]);
      showApp();
    } catch (err) {
      console.error(err);
      toast("Không thể tải hồ sơ người dùng.");
    }
  } else {
    currentUser = null;
    profile = null;
    showLogin();
  }
});

function showLogin() {
  $("#screen-login").hidden = false;
  $("#app").hidden = true;
  $("#form-login").reset();
  window.scrollTo(0, 0);
}

function showApp() {
  $("#screen-login").hidden = true;
  $("#app").hidden = false;
  updateNetworkBanner();
  window.scrollTo(0, 0);
  const roleLabel = isAdmin() ? "Chủ quán" : "Nhân viên";
  const locLabel = profile.locationId ? " · " + locationName(profile.locationId) : "";
  $("#user-chip").textContent = `${profile.name} · ${roleLabel}${locLabel}`;
  $$(".nav-item[data-admin-only]").forEach((btn) => { btn.hidden = !isAdmin(); });
  if (!isAdmin() && !profile.locationId) {
    toast("Tài khoản của bạn chưa được gán điểm bán. Liên hệ chủ quán để được gán.");
  }
  if (!location.hash || (!isAdmin() && ["#/bao-cao", "#/quan-ly"].includes(location.hash))) {
    location.hash = "#/trang-chu";
  } else {
    router();
  }
}

/* ===================== DATA LOADING ===================== */
async function loadStaffDirectory() {
  const snap = await getDocs(collection(db, "users"));
  staffDirectory = {};
  snap.forEach((d) => { staffDirectory[d.id] = d.data(); });
}

async function loadLocationsDirectory() {
  const snap = await getDocs(collection(db, "locations"));
  locationsDirectory = {};
  snap.forEach((d) => { locationsDirectory[d.id] = d.data(); });
}

async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "general"));
    if (snap.exists()) settings = { ...settings, ...snap.data() };
  } catch (err) { console.error(err); }
}

// Định mức nguyên liệu/phần (BOM) + ngưỡng cảnh báo tồn kho, mỗi nguyên liệu
// 1 document trong collection itemCatalog (id = tên đã slug hoá).
// Chỉ giữ ký tự a-z0-9 làm phần dễ đọc, ghép thêm 1 mã hash ngắn để đảm bảo
// không trùng id giữa các nguyên liệu tiếng Việt khác nhau (vd "Gà" vs "Gạo").
function slugifyItemName(name) {
  const trimmed = (name || "").trim();
  let hash = 0;
  for (let i = 0; i < trimmed.length; i++) hash = (hash * 31 + trimmed.charCodeAt(i)) >>> 0;
  const asciiPart = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return (asciiPart || "item") + "-" + hash.toString(36);
}

async function loadItemCatalog() {
  try {
    const snap = await getDocs(collection(db, "itemCatalog"));
    itemCatalog = {};
    snap.forEach((d) => {
      const data = d.data();
      if (data.itemName) itemCatalog[data.itemName] = { id: d.id, ...data };
    });
  } catch (err) { console.error(err); }
}

// Giá trung bình/đơn vị của 1 nguyên liệu, tính từ lịch sử nhập hàng gần đây
// (tổng thành tiền / tổng số lượng đã nhập trong cửa sổ ngày truyền vào).
function avgUnitCostMap(ingRows) {
  const map = {};
  ingRows.forEach((r) => {
    if (!r.itemName) return;
    map[r.itemName] = map[r.itemName] || { unit: r.unit, totalQty: 0, totalTien: 0 };
    map[r.itemName].totalQty += r.qty || 0;
    map[r.itemName].totalTien += r.tien || 0;
    if (r.unit) map[r.itemName].unit = r.unit;
  });
  Object.values(map).forEach((v) => { v.avgCost = v.totalQty ? v.totalTien / v.totalQty : 0; });
  return map;
}

// Giá vốn nguyên liệu ước tính / 1 phần xôi bán ra = tổng (định mức × giá TB/đơn vị)
// trên các nguyên liệu đã được đặt định mức ở mục Quản lý.
async function computeGiaVonPerPhan() {
  try {
    const from = addDays(todayISO(), -STOCK_WINDOW_DAYS);
    const rows = await fetchIngredientsByRange(from, todayISO());
    const costMap = avgUnitCostMap(rows);
    let total = 0;
    Object.entries(itemCatalog).forEach(([name, cat]) => {
      if (!cat.qtyPerPortion) return;
      const c = costMap[name];
      total += (cat.qtyPerPortion || 0) * (c ? c.avgCost : 0);
    });
    return total;
  } catch (err) {
    console.error(err);
    return 0;
  }
}

async function fetchEntriesByUid(uid) {
  const q = query(collection(db, "entries"), where("uid", "==", uid));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  return rows;
}

async function fetchEntriesByRange(from, to) {
  const q = query(collection(db, "entries"), where("date", ">=", from), where("date", "<=", to), orderBy("date", "asc"));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

async function fetchIngredientsByRange(from, to) {
  const q = query(collection(db, "ingredients"), where("date", ">=", from), where("date", "<=", to), orderBy("date", "asc"));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

async function fetchTransfersByRange(from, to) {
  const q = query(collection(db, "transfers"), where("date", ">=", from), where("date", "<=", to), orderBy("date", "asc"));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

async function fetchOrdersByRange(from, to) {
  const q = query(collection(db, "orders"), where("date", ">=", from), where("date", "<=", to), orderBy("date", "asc"));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

async function fetchThuChiByRange(from, to) {
  const q = query(collection(db, "thuchi"), where("date", ">=", from), where("date", "<=", to), orderBy("date", "asc"));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

/* ===================== ROUTER ===================== */
const ADMIN_ONLY = ["bao-cao", "quan-ly", "thu-chi"];
const TITLES = {
  "trang-chu": "Trang chủ", "cham-cong": "Chấm công", "kho": "Kho & Chuyển hàng",
  "thu-chi": "Thu & chi", "bao-cao": "Báo cáo", "quan-ly": "Quản lý",
};

window.addEventListener("hashchange", router);
$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => { location.hash = "#/" + btn.dataset.view; });
});

function router() {
  if (!profile) return;
  let view = (location.hash || "#/trang-chu").replace("#/", "");
  if (!TITLES[view]) view = "trang-chu";
  if (ADMIN_ONLY.includes(view) && !isAdmin()) {
    toast("Bạn không có quyền truy cập mục này.");
    view = "trang-chu";
    location.hash = "#/trang-chu";
  }
  $("#view-title").textContent = TITLES[view];
  $$(".nav-item").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === view));
  window.scrollTo(0, 0);

  if (view === "trang-chu") renderTrangChu();
  else if (view === "cham-cong") renderChamCong();
  else if (view === "kho") renderKho();
  else if (view === "thu-chi") renderThuChi();
  else if (view === "bao-cao") renderBaoCao();
  else if (view === "quan-ly") renderQuanLy();
}

function mount(id) {
  const tpl = $("#tpl-" + id);
  viewRoot.innerHTML = "";
  viewRoot.appendChild(tpl.content.cloneNode(true));
}

/* ===================== TRANG CHỦ ===================== */
async function renderTrangChu() {
  mount("trang-chu");
  $('[data-bind="today-date"]').textContent = formatDateVN(todayISO());

  const statsEl = $('[data-bind="hero-stats"]');
  const actionsEl = $('[data-bind="quick-actions"]');
  const recentEl = $('[data-bind="recent-list"]');
  const byLocEl = $('[data-bind="home-by-location"]');
  const attendanceBlockEl = $('[data-bind="attendance-block"]');
  const attendanceDateEl = $("#attendance-date");
  statsEl.innerHTML = `<div class="hero-stat"><span class="num">…</span><span class="label">Đang tải</span></div>`;

  if (isAdmin()) {
    if (attendanceBlockEl) attendanceBlockEl.hidden = false;
    if (attendanceDateEl) {
      attendanceDateEl.value = todayISO();
      attendanceDateEl.max = todayISO();
      attendanceDateEl.addEventListener("change", () => renderAttendanceStatus(attendanceDateEl.value));
    }
  } else if (attendanceBlockEl) {
    attendanceBlockEl.hidden = true;
  }

  actionsEl.innerHTML = `
    <button class="quick-action" data-go="cham-cong">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
      Chấm công hôm nay
    </button>
    <button class="quick-action" data-go="kho">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3h14l-1 6a6 6 0 0 1-12 0L5 3Z"/><path d="M9 21h6M12 15v6"/></svg>
      ${isKitchenContext() ? "Kho & chuyển hàng" : "Hàng đã nhận"}
    </button>
    ${isAdmin() ? `<button class="quick-action" data-go="bao-cao">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>
      Xem báo cáo
    </button>` : ""}
  `;
  $$("[data-go]", actionsEl).forEach((b) => b.addEventListener("click", () => { location.hash = "#/" + b.dataset.go; }));

  try {
    if (isAdmin()) {
      const today = todayISO();
      const rows = await fetchEntriesByRange(today, today);
      const worked = rows.filter((r) => !r.offDay);
      const totalDoanhThu = worked.reduce((s, r) => s + (r.soLuong || 0) * locationGiaBan(r.locationId), 0);
      const soNVLam = new Set(worked.map((r) => r.uid)).size;
      statsEl.innerHTML = `
        <div class="hero-stat"><span class="num">${fmt(totalDoanhThu)}</span><span class="label">Doanh thu ước tính hôm nay (tất cả điểm)</span></div>
        <div class="hero-stat"><span class="num">${soNVLam}</span><span class="label">Nhân viên đã chấm công</span></div>
      `;
      recentEl.innerHTML = renderEntryCards(rows.slice(0, 6), true, false, true) || emptyState("Chưa có phiếu chấm công hôm nay");

      if (byLocEl) {
        const locs = activeLocations().filter(([, l]) => l.type === "point");
        byLocEl.innerHTML = locs.length ? locs.map(([id, l]) => {
          const locRows = worked.filter((r) => r.locationId === id);
          const dt = locRows.reduce((s, r) => s + (r.soLuong || 0) * locationGiaBan(id), 0);
          return `<div class="stat-card"><div class="label">${escapeHtml(l.name)}</div><div class="value">${fmt(dt)}</div></div>`;
        }).join("") : emptyState("Chưa có điểm bán nào — vào mục Quản lý để thêm");
      }
      await renderAttendanceStatus(todayISO());
      await renderHomeReminders();
    } else {
      const rows = await fetchEntriesByUid(currentUser.uid);
      const todayRow = rows.find((r) => r.date === todayISO());
      const weekStart = mondayOf(todayISO());
      const weekRows = rows.filter((r) => r.date >= weekStart && r.date <= todayISO());
      const weekTotal = weekRows.filter((r) => !r.offDay).reduce((s, r) => s + (r.tong || 0), 0);
      statsEl.innerHTML = `
        <div class="hero-stat"><span class="num">${todayRow ? fmt(todayRow.tong) : "Chưa chấm"}</span><span class="label">Hôm nay</span></div>
        <div class="hero-stat"><span class="num">${fmt(weekTotal)}</span><span class="label">Tuần này (tạm tính)</span></div>
      `;
      recentEl.innerHTML = renderEntryCards(rows.slice(0, 6), false, false) || emptyState("Bạn chưa có phiếu chấm công nào");
      if (byLocEl) byLocEl.innerHTML = "";
    }
  } catch (err) {
    console.error(err);
    statsEl.innerHTML = `<div class="hero-stat"><span class="num">—</span><span class="label">Lỗi tải dữ liệu</span></div>`;
  }
}

// Nhắc nhở trong app khi mở Trang chủ (chủ quán): nhân viên chưa chấm công
// (chỉ nhắc từ cuối giờ chiều để khỏi làm phiền cả ngày) + nguyên liệu sắp
// hết ở bếp. Đây KHÔNG phải push notification thật (app vẫn phải đang mở) —
// vì app này chạy tĩnh trên GitHub Pages, không có server để đẩy thông báo
// khi điện thoại tắt màn hình/đóng app; muốn có push thật cần thêm Cloud
// Functions + Firebase Cloud Messaging và nâng cấp gói Firebase lên Blaze.
async function renderHomeReminders() {
  const el = $('[data-bind="home-reminders"]');
  if (!el) return;
  const banners = [];
  try {
    const today = todayISO();
    if (new Date().getHours() >= 17) {
      const rows = await fetchEntriesByRange(today, today);
      const byUid = {};
      rows.forEach((r) => { byUid[r.uid] = r; });
      const missing = Object.entries(staffDirectory).filter(([uid, u]) => u.active !== false && u.locationId && !byUid[uid]);
      if (missing.length) {
        banners.push(`<div class="reminder-banner">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
          <span>${missing.length} nhân viên chưa chấm công hôm nay: ${missing.map(([, u]) => escapeHtml(u.name || "?")).join(", ")}.</span>
        </div>`);
      }
    }
    const from = addDays(today, -STOCK_WINDOW_DAYS);
    const [allIng, allTrf] = await Promise.all([fetchIngredientsByRange(from, today), fetchTransfersByRange(from, today)]);
    const stock = {};
    allIng.forEach((r) => { stock[r.itemName] = (stock[r.itemName] || 0) + (r.qty || 0); });
    allTrf.forEach((r) => { stock[r.itemName] = (stock[r.itemName] || 0) - (r.qty || 0); });
    const lowItems = Object.entries(stock).filter(([name, ton]) => {
      const th = itemCatalog[name]?.threshold;
      return th && ton < th;
    });
    if (lowItems.length) {
      banners.push(`<div class="reminder-banner gold">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
          <span>Sắp hết ${lowItems.length} nguyên liệu ở bếp: ${lowItems.map(([name]) => escapeHtml(name)).join(", ")}.</span>
      </div>`);
    }
  } catch (err) { console.error(err); }
  el.innerHTML = banners.join("");
}

// Điểm danh chấm công theo ngày (chỉ chủ quán): xem nhanh nhân viên nào
// đã tự chấm công / chưa chấm công / nghỉ, không cần lục trong báo cáo.
async function renderAttendanceStatus(dateStr) {
  const listEl = $('[data-bind="attendance-list"]');
  const sumEl = $('[data-bind="attendance-summary"]');
  if (!listEl) return;
  listEl.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  if (sumEl) sumEl.innerHTML = "";
  try {
    const rows = await fetchEntriesByRange(dateStr, dateStr);
    const byUid = {};
    rows.forEach((r) => { byUid[r.uid] = r; });

    const staffList = Object.entries(staffDirectory).filter(([, u]) => u.active !== false && u.locationId);
    if (!staffList.length) {
      listEl.innerHTML = emptyState("Chưa có nhân viên nào được gán điểm bán — vào mục Quản lý để thêm");
      return;
    }

    const daChamCong = staffList.filter(([uid]) => byUid[uid] && !byUid[uid].offDay).length;
    if (sumEl) {
      sumEl.innerHTML = `<p class="hint-text">${daChamCong}/${staffList.length} nhân viên đã chấm công ngày ${formatDateVN(dateStr)}.</p>`;
    }

    staffList.sort((a, b) => {
      const rank = (uid) => (!byUid[uid] ? 0 : byUid[uid].offDay ? 1 : 2); // chưa chấm công lên đầu, rồi nghỉ, rồi đã chấm công
      const rA = rank(a[0]), rB = rank(b[0]);
      if (rA !== rB) return rA - rB;
      return (a[1].name || "").localeCompare(b[1].name || "", "vi");
    });

    listEl.innerHTML = staffList.map(([uid, u]) => {
      const entry = byUid[uid];
      let statusHtml, metaHtml = "";
      if (!entry) {
        statusHtml = `<span class="badge-unpaid">Chưa chấm công</span>`;
      } else if (entry.offDay) {
        statusHtml = `<span class="entry-off-badge">Nghỉ</span>`;
      } else {
        statusHtml = `<span class="badge-paid">Đã chấm công</span>`;
        metaHtml = `<div class="entry-meta">
          <span>Số lượng: <b>${fmtNum(entry.soLuong)}</b></span>
          <span>Tổng: <b>${fmt(entry.tong)}</b></span>
        </div>`;
      }
      return `
        <div class="entry-card">
          <div class="entry-card-top">
            <span class="entry-date">${escapeHtml(u.name || "(chưa đặt tên)")} · ${escapeHtml(locationName(u.locationId))}</span>
            ${statusHtml}
          </div>
          ${metaHtml}
        </div>
      `;
    }).join("");
  } catch (err) {
    console.error(err);
    listEl.innerHTML = emptyState("Không tải được dữ liệu điểm danh");
  }
}

/* ===================== CHẤM CÔNG ===================== */
let entryCacheForUser = [];
// uid mà admin đang xem/sửa phiếu chấm công (mặc định là chính admin). Nhân
// viên thường luôn quản lý phiếu của chính mình, không đổi được giá trị này.
let entryTargetUid = null;

function currentEntryLocationId() {
  return staffDirectory[entryTargetUid]?.locationId ?? profile.locationId;
}

async function renderChamCong() {
  mount("cham-cong");
  editingEntryId = null;
  entryListLimit = 30;

  if (!isAdmin() && !profile.locationId) {
    viewRoot.innerHTML = emptyState("Bạn chưa được gán điểm bán nên chưa thể chấm công. Liên hệ chủ quán.");
    return;
  }

  entryTargetUid = currentUser.uid;
  const staffSelectWrap = $('[data-bind="entry-staff-select"]');
  if (isAdmin() && staffSelectWrap) {
    const staffList = Object.entries(staffDirectory)
      .filter(([, u]) => u.active !== false && u.locationId)
      .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || "", "vi"));
    if (staffList.length) {
      const defaultUid = staffList.some(([uid]) => uid === currentUser.uid) ? currentUser.uid : staffList[0][0];
      entryTargetUid = defaultUid;
      staffSelectWrap.hidden = false;
      staffSelectWrap.innerHTML = `<label class="field"><span>Xem / sửa chấm công của</span>
        <select id="entry-staff-select">
          ${staffList.map(([uid, u]) => `<option value="${uid}" ${uid === defaultUid ? "selected" : ""}>${escapeHtml(u.name || "(chưa đặt tên)")}${uid === currentUser.uid ? " (bạn)" : ""} · ${escapeHtml(locationName(u.locationId))}</option>`).join("")}
        </select>
      </label>`;
      $("#entry-staff-select").addEventListener("change", async (e) => {
        entryTargetUid = e.target.value;
        resetEntryForm();
        updateEntryLocationBadge();
        await loadAndRenderEntryList();
      });
    } else {
      staffSelectWrap.hidden = true;
    }
  } else if (staffSelectWrap) {
    staffSelectWrap.hidden = true;
  }

  function updateEntryLocationBadge() {
    const locBadge = $('[data-bind="entry-location"]');
    if (!locBadge) return;
    const locId = currentEntryLocationId();
    if (isAdmin() && entryTargetUid !== currentUser.uid) {
      const nm = staffDirectory[entryTargetUid]?.name || "Nhân viên";
      locBadge.textContent = `${nm} · ${locationName(locId)}`;
    } else {
      locBadge.textContent = locationName(locId);
    }
  }
  updateEntryLocationBadge();

  const dateEl = $("#entry-date");
  dateEl.value = todayISO();
  $("#entry-luong").value = locationsDirectory[currentEntryLocationId()]?.luongMacDinh ?? settings.luongMacDinh ?? "";

  const offEl = $("#entry-off");
  const workFields = $("#entry-work-fields");
  offEl.addEventListener("change", () => {
    $$("input", workFields).forEach((i) => (i.disabled = offEl.checked));
  });

  const luongEl = $("#entry-luong"), thuongEl = $("#entry-thuong"), tongEl = $("#entry-tong");
  function recalcTong() {
    const l = parseFloat(luongEl.value) || 0, t = parseFloat(thuongEl.value) || 0;
    tongEl.value = l + t;
  }
  luongEl.addEventListener("input", recalcTong);
  thuongEl.addEventListener("input", recalcTong);

  $("#btn-entry-cancel").addEventListener("click", () => resetEntryForm());

  $("#form-entry").addEventListener("submit", async (e) => {
    e.preventDefault();
    const off = offEl.checked;
    const targetLocationId = currentEntryLocationId();
    if (!targetLocationId) {
      toast(entryTargetUid === currentUser.uid
        ? "Tài khoản của bạn chưa được gán điểm bán. Vào Quản lý > Nhân sự để gán điểm bán trước khi chấm công."
        : "Nhân viên này chưa được gán điểm bán.");
      return;
    }
    const payload = {
      uid: entryTargetUid,
      name: staffDirectory[entryTargetUid]?.name || (entryTargetUid === currentUser.uid ? (profile.name || "") : ""),
      locationId: targetLocationId,
      date: dateEl.value,
      offDay: off,
      luong: off ? 0 : (parseFloat(luongEl.value) || 0),
      soLuong: off ? 0 : (parseInt($("#entry-soluong").value) || 0),
      thuong: off ? 0 : (parseFloat(thuongEl.value) || 0),
      tong: off ? 0 : (parseFloat(tongEl.value) || 0),
      ship: off ? 0 : (parseInt($("#entry-ship").value) || 0),
      dep: off ? 0 : (parseInt($("#entry-dep").value) || 0),
      ghiChu: $("#entry-ghichu").value.trim(),
      updatedAt: serverTimestamp(),
    };
    const wasEditing = !!editingEntryId;
    if (!wasEditing) payload.createdAt = serverTimestamp();
    await saveOp(
      () => (wasEditing ? updateDoc(doc(db, "entries", editingEntryId), payload) : addDoc(collection(db, "entries"), payload)),
      async (confirmed) => {
        toast(wasEditing ? "Đã cập nhật phiếu chấm công" : (confirmed ? "Đã lưu phiếu chấm công" : "Đã lưu phiếu (chưa có mạng — sẽ tự đồng bộ)"));
        resetEntryForm();
        await loadAndRenderEntryList();
      }
    );
  });

  $("#entry-filter").addEventListener("change", () => { entryListLimit = 30; renderEntryListFiltered(); });
  $("#entry-search").addEventListener("input", () => { entryListLimit = 30; renderEntryListFiltered(); });
  $('[data-bind="entry-list-more"]').addEventListener("click", () => { entryListLimit += 30; renderEntryListFiltered(); });

  await loadAndRenderEntryList();
}

function resetEntryForm() {
  editingEntryId = null;
  const f = $("#form-entry");
  if (!f) return;
  f.reset();
  $("#entry-date").value = todayISO();
  $("#entry-luong").value = locationsDirectory[currentEntryLocationId()]?.luongMacDinh ?? settings.luongMacDinh ?? "";
  $("#btn-entry-cancel").hidden = true;
  $$("input", $("#entry-work-fields")).forEach((i) => (i.disabled = false));
}

async function loadAndRenderEntryList() {
  const list = $('[data-bind="entry-list"]');
  list.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  try {
    entryCacheForUser = await fetchEntriesByUid(entryTargetUid || currentUser.uid);
    renderEntryListFiltered();
  } catch (err) {
    console.error(err);
    list.innerHTML = emptyState("Không tải được lịch sử");
  }
}

function renderEntryListFiltered() {
  const days = parseInt($("#entry-filter").value, 10);
  const cutoff = addDays(todayISO(), -days);
  const term = $("#entry-search")?.value.trim() || "";
  const rows = entryCacheForUser.filter((r) => r.date >= cutoff && matchesSearch(r, term, ["ghiChu", "name"]));
  $('[data-bind="entry-list"]').innerHTML = renderEntryCards(rows.slice(0, entryListLimit), false, true) || emptyState(term ? "Không tìm thấy phiếu nào khớp" : "Không có dữ liệu trong khoảng này");
  const moreEl = $('[data-bind="entry-list-more"]');
  if (moreEl) moreEl.hidden = rows.length <= entryListLimit;
}

function renderEntryCards(rows, showName, showActions = false, showLocation = false) {
  if (!rows.length) return "";
  return rows.map((r) => `
    <div class="entry-card" data-id="${r.id}">
      <div class="entry-card-top">
        <span class="entry-date">${formatDateVN(r.date)}${showName ? " · " + (r.name || staffName(r.uid)) : ""}${showLocation ? " · " + escapeHtml(locationName(r.locationId)) : ""}</span>
        ${r.offDay ? '<span class="entry-off-badge">Nghỉ</span>' : `<span class="entry-total">${fmt(r.tong)}</span>`}
      </div>
      ${r.offDay ? "" : `
      <div class="entry-meta">
        <span>Lương: <b>${fmt(r.luong)}</b></span>
        <span>Số lượng: <b>${fmtNum(r.soLuong)}</b></span>
        <span>Thưởng: <b>${fmt(r.thuong)}</b></span>
        ${r.ship ? `<span>Ship: <b>${fmtNum(r.ship)}</b></span>` : ""}
        ${r.dep ? `<span>Xôi ship/dẹp: <b>${fmtNum(r.dep)}</b></span>` : ""}
      </div>`}
      ${r.ghiChu ? `<div class="entry-note">${escapeHtml(r.ghiChu)}</div>` : ""}
      ${showActions ? `
      <div class="entry-row-actions">
        <button class="link-btn" data-edit="${r.id}">Sửa</button>
        <button class="link-btn danger" data-del="${r.id}">Xoá</button>
      </div>` : ""}
    </div>
  `).join("");
}

// Event delegation cho các nút sửa/xoá trong view-root (view-root tồn tại xuyên suốt các lần render)
viewRoot.addEventListener("click", async (e) => {
  const thumbEl = e.target.closest(".receipt-thumb");
  if (thumbEl) { openLightbox(thumbEl.src); return; }

  const editBtn = e.target.closest("[data-edit]");
  const delBtn = e.target.closest("[data-del]");
  if (editBtn && $("#form-entry")) {
    const id = editBtn.dataset.edit;
    const row = entryCacheForUser.find((r) => r.id === id);
    if (!row) return;
    editingEntryId = id;
    $("#entry-date").value = row.date;
    $("#entry-off").checked = !!row.offDay;
    $$("input", $("#entry-work-fields")).forEach((i) => (i.disabled = !!row.offDay));
    $("#entry-luong").value = row.luong || 0;
    $("#entry-soluong").value = row.soLuong || 0;
    $("#entry-thuong").value = row.thuong || 0;
    $("#entry-tong").value = row.tong || 0;
    $("#entry-ship").value = row.ship || 0;
    $("#entry-dep").value = row.dep || 0;
    $("#entry-ghichu").value = row.ghiChu || "";
    $("#btn-entry-cancel").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  if (delBtn && $("#form-entry")) {
    const id = delBtn.dataset.del;
    if (!confirm("Xoá phiếu chấm công này?")) return;
    try {
      await deleteDoc(doc(db, "entries", id));
      toast("Đã xoá phiếu");
      await loadAndRenderEntryList();
    } catch (err) { console.error(err); toast("Không xoá được"); }
  }

  const ingEditBtn = e.target.closest("[data-ing-edit]");
  const ingDelBtn = e.target.closest("[data-ing-del]");
  if (ingEditBtn) {
    const id = ingEditBtn.dataset.ingEdit;
    const row = ingCacheGlobal.find((r) => r.id === id);
    if (!row) return;
    editingIngId = id;
    $("#ing-date").value = row.date;
    $("#ing-item").value = row.itemName || "";
    $("#ing-unit").value = row.unit || "kg";
    $("#ing-qty").value = row.qty || "";
    $("#ing-tien").value = row.tien || "";
    $("#ing-ghichu").value = row.ghiChu || "";
    ingReceiptCtl?.set(row.anhHoaDon || "");
    $("#btn-ing-cancel").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  if (ingDelBtn) {
    const id = ingDelBtn.dataset.ingDel;
    if (!confirm("Xoá lần nhập nguyên liệu này?")) return;
    try {
      await deleteDoc(doc(db, "ingredients", id));
      toast("Đã xoá");
      await loadAndRenderKho();
    } catch (err) { console.error(err); toast("Không xoá được"); }
  }

  const trfEditBtn = e.target.closest("[data-trf-edit]");
  const trfDelBtn = e.target.closest("[data-trf-del]");
  if (trfEditBtn) {
    const id = trfEditBtn.dataset.trfEdit;
    const row = transferCacheGlobal.find((r) => r.id === id);
    if (!row) return;
    editingTransferId = id;
    $("#trf-date").value = row.date;
    $("#trf-to").value = row.toLocationId || "";
    $("#trf-item").value = row.itemName || "";
    $("#trf-unit").value = row.unit || "kg";
    $("#trf-qty").value = row.qty || "";
    $("#trf-ghichu").value = row.ghiChu || "";
    $("#btn-trf-cancel").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  if (trfDelBtn) {
    const id = trfDelBtn.dataset.trfDel;
    if (!confirm("Xoá lần chuyển hàng này?")) return;
    try {
      await deleteDoc(doc(db, "transfers", id));
      toast("Đã xoá");
      await loadAndRenderKho();
    } catch (err) { console.error(err); toast("Không xoá được"); }
  }

  const orderFillBtn = e.target.closest("[data-order-fill]");
  const orderDoneBtn = e.target.closest("[data-order-done]");
  const orderCancelBtn = e.target.closest("[data-order-cancel]");
  if (orderFillBtn) {
    const id = orderFillBtn.dataset.orderFill;
    const row = ordersCacheGlobal.find((r) => r.id === id);
    if (!row) return;
    if ($("#trf-to")) $("#trf-to").value = row.locationId || "";
    if ($("#trf-item")) $("#trf-item").value = row.itemName || "";
    if ($("#trf-unit")) $("#trf-unit").value = row.unit || "kg";
    if ($("#trf-qty")) $("#trf-qty").value = row.qty || "";
    if ($("#trf-ghichu")) $("#trf-ghichu").value = row.ghiChu ? `Theo yêu cầu: ${row.ghiChu}` : "";
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast("Đã điền vào form chuyển hàng — kiểm tra rồi bấm Lưu");
  }
  if (orderDoneBtn) {
    const id = orderDoneBtn.dataset.orderDone;
    try {
      await updateDoc(doc(db, "orders", id), { status: "xong", updatedAt: serverTimestamp() });
      toast("Đã đánh dấu đã chuyển");
      await loadAndRenderOrderRequests();
    } catch (err) { console.error(err); toast("Không cập nhật được"); }
  }
  if (orderCancelBtn) {
    const id = orderCancelBtn.dataset.orderCancel;
    if (!confirm("Huỷ đơn đặt hàng này?")) return;
    try {
      await updateDoc(doc(db, "orders", id), { status: "huy", updatedAt: serverTimestamp() });
      toast("Đã huỷ đơn");
      await loadAndRenderMyOrders();
    } catch (err) { console.error(err); toast("Không huỷ được"); }
  }

  const tcEditBtn = e.target.closest("[data-tc-edit]");
  const tcDelBtn = e.target.closest("[data-tc-del]");
  if (tcEditBtn) {
    const id = tcEditBtn.dataset.tcEdit;
    const row = thuChiCacheGlobal.find((r) => r.id === id);
    if (!row) return;
    editingThuChiId = id;
    $("#tc-loai").value = row.loai === "thu" ? "thu" : "chi";
    $("#tc-date").value = row.date;
    $("#tc-danhmuc").value = row.danhMuc || "";
    $("#tc-sotien").value = row.soTien || 0;
    $("#tc-location").value = row.locationId || "";
    $("#tc-ghichu").value = row.ghiChu || "";
    tcReceiptCtl?.set(row.anhHoaDon || "");
    $("#btn-tc-cancel").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  if (tcDelBtn) {
    const id = tcDelBtn.dataset.tcDel;
    if (!confirm("Xoá giao dịch thu/chi này?")) return;
    try {
      await deleteDoc(doc(db, "thuchi", id));
      toast("Đã xoá giao dịch");
      await loadAndRenderThuChi();
    } catch (err) { console.error(err); toast("Không xoá được"); }
  }

  const locEditBtn = e.target.closest("[data-loc-edit]");
  const locToggleBtn = e.target.closest("[data-loc-toggle]");
  const locDelBtn = e.target.closest("[data-loc-del]");
  if (locDelBtn) {
    const id = locDelBtn.dataset.locDel;
    const l = locationsDirectory[id];
    if (!confirm(`Xoá điểm bán "${l?.name || ""}"? Chỉ nên xoá nếu điểm này chưa có phiếu chấm công / dữ liệu nào gắn vào.`)) return;
    try {
      await deleteDoc(doc(db, "locations", id));
      toast("Đã xoá điểm bán");
      await loadLocationsDirectory();
      renderLocationList();
      populateStaffLocationSelect();
    } catch (err) { console.error(err); toast("Không xoá được: " + (err.message || "")); }
  }
  if (locEditBtn) {
    const id = locEditBtn.dataset.locEdit;
    const l = locationsDirectory[id];
    if (!l) return;
    editingLocationId = id;
    $("#loc-name").value = l.name || "";
    $("#loc-type").value = l.type || "point";
    $("#loc-address").value = l.address || "";
    $("#loc-giaban").value = l.giaBan ?? "";
    $("#loc-luong").value = l.luongMacDinh ?? "";
    $("#btn-loc-cancel").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  if (locToggleBtn) {
    const id = locToggleBtn.dataset.locToggle;
    const l = locationsDirectory[id];
    try {
      await updateDoc(doc(db, "locations", id), { active: !(l.active !== false) });
      toast("Đã cập nhật trạng thái điểm");
      await loadLocationsDirectory();
      renderLocationList();
    } catch (err) { console.error(err); toast("Không cập nhật được"); }
  }
});

/* ===================== KHO & CHUYỂN HÀNG ===================== */
let ingCacheGlobal = [];
let transferCacheGlobal = [];
let ordersCacheGlobal = [];

function itemDatalistHtml() {
  return `<datalist id="item-suggestions">${ITEM_SUGGESTIONS.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("")}</datalist>`;
}

async function renderKho() {
  mount("kho");
  editingIngId = null;
  editingTransferId = null;
  ingListLimit = 30;
  trfListLimit = 30;
  viewRoot.insertAdjacentHTML("beforeend", itemDatalistHtml());

  const kitchenMode = isKitchenContext();
  const readonlyEl = $('[data-bind="kho-readonly"]');
  const manageEl = $('[data-bind="kho-manage"]');

  if (!kitchenMode) {
    // Điểm bán: xem hàng đã nhận từ bếp (không sửa được) + tự đặt hàng nguyên liệu cần
    manageEl.hidden = true;
    readonlyEl.hidden = false;
    if (!profile.locationId) {
      readonlyEl.innerHTML = emptyState("Bạn chưa được gán điểm bán.");
      return;
    }

    $("#order-date").value = todayISO();
    $("#form-order").addEventListener("submit", async (e) => {
      e.preventDefault();
      const itemName = $("#order-item").value.trim();
      const qty = parseFloat($("#order-qty").value) || 0;
      if (!itemName) { toast("Nhập tên nguyên liệu / mặt hàng cần"); return; }
      if (qty <= 0) { toast("Nhập số lượng lớn hơn 0"); return; }
      const payload = {
        uid: currentUser.uid,
        locationId: profile.locationId,
        date: $("#order-date").value,
        itemName,
        unit: $("#order-unit").value,
        qty,
        ghiChu: $("#order-ghichu").value.trim(),
        status: "moi",
        updatedAt: serverTimestamp(),
      };
      payload.createdAt = serverTimestamp();
      await saveOp(
        () => addDoc(collection(db, "orders"), payload),
        async (confirmed) => {
          toast(confirmed ? "Đã gửi yêu cầu tới bếp" : "Đã lưu yêu cầu (chưa có mạng — sẽ tự đồng bộ)");
          $("#form-order").reset();
          $("#order-date").value = todayISO();
          await loadAndRenderMyOrders();
        }
      );
    });

    await Promise.all([loadAndRenderMyOrders(), loadAndRenderReceived()]);
    return;
  }

  readonlyEl.hidden = true;
  manageEl.hidden = false;

  const kLocs = kitchenLocations();
  const kitchenSelectWrap = $('[data-bind="kitchen-select"]');
  if (!kLocs.length) {
    manageEl.innerHTML = emptyState("Chưa có bếp trung tâm nào — vào mục Quản lý để thêm điểm loại “Bếp trung tâm”.");
    return;
  }
  let opKitchenId = operatingKitchenId();
  if (kitchenSelectWrap) {
    if (isAdmin() && kLocs.length > 1) {
      kitchenSelectWrap.innerHTML = `<label class="field"><span>Bếp</span>
        <select id="kho-kitchen-select">${kLocs.map(([id, l]) => `<option value="${id}" ${id === opKitchenId ? "selected" : ""}>${escapeHtml(l.name)}</option>`).join("")}</select>
      </label>`;
      $("#kho-kitchen-select").addEventListener("change", (e) => { opKitchenId = e.target.value; loadAndRenderKho(opKitchenId); });
    } else {
      kitchenSelectWrap.innerHTML = `<p class="eyebrow">Bếp: ${escapeHtml(locationName(opKitchenId))}</p>`;
    }
  }

  $("#ing-date").value = todayISO();
  $("#trf-date").value = todayISO();
  ingReceiptCtl = wireReceiptInput("ing-anh", "ing-anh-row", "ing-anh-preview", "ing-anh-clear");
  const trfToSel = $("#trf-to");
  const pLocs = pointLocations();
  trfToSel.innerHTML = pLocs.length
    ? pLocs.map(([id, l]) => `<option value="${id}">${escapeHtml(l.name)}</option>`).join("")
    : `<option value="">(chưa có điểm bán)</option>`;

  $("#btn-ing-cancel").addEventListener("click", () => resetIngForm());
  $("#btn-trf-cancel").addEventListener("click", () => resetTrfForm());
  $("#ing-search").addEventListener("input", () => { ingListLimit = 30; renderIngListUI(); });
  $("#trf-search").addEventListener("input", () => { trfListLimit = 30; renderTrfListUI(); });
  $('[data-bind="ing-list-more"]').addEventListener("click", () => { ingListLimit += 30; renderIngListUI(); });
  $('[data-bind="trf-list-more"]').addEventListener("click", () => { trfListLimit += 30; renderTrfListUI(); });

  $("#form-ing").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      uid: currentUser.uid,
      locationId: opKitchenId,
      date: $("#ing-date").value,
      itemName: $("#ing-item").value.trim(),
      unit: $("#ing-unit").value,
      qty: parseFloat($("#ing-qty").value) || 0,
      tien: parseFloat($("#ing-tien").value) || 0,
      ghiChu: $("#ing-ghichu").value.trim(),
      updatedAt: serverTimestamp(),
    };
    if (!payload.itemName) { toast("Nhập tên nguyên liệu"); return; }
    payload.anhHoaDon = ingReceiptCtl ? ingReceiptCtl.get() : "";
    const wasEditing = !!editingIngId;
    if (!wasEditing) payload.createdAt = serverTimestamp();
    await saveOp(
      () => (wasEditing ? updateDoc(doc(db, "ingredients", editingIngId), payload) : addDoc(collection(db, "ingredients"), payload)),
      async (confirmed) => {
        toast(wasEditing ? "Đã cập nhật" : (confirmed ? "Đã lưu nguyên liệu" : "Đã lưu (chưa có mạng — sẽ tự đồng bộ)"));
        resetIngForm();
        await loadAndRenderKho(opKitchenId);
      }
    );
  });

  $("#form-trf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const toId = $("#trf-to").value;
    if (!toId) { toast("Chọn điểm bán nhận hàng"); return; }
    const payload = {
      uid: currentUser.uid,
      fromLocationId: opKitchenId,
      toLocationId: toId,
      date: $("#trf-date").value,
      itemName: $("#trf-item").value.trim(),
      unit: $("#trf-unit").value,
      qty: parseFloat($("#trf-qty").value) || 0,
      ghiChu: $("#trf-ghichu").value.trim(),
      updatedAt: serverTimestamp(),
    };
    if (!payload.itemName) { toast("Nhập tên hàng chuyển"); return; }
    const wasEditing = !!editingTransferId;
    if (!wasEditing) payload.createdAt = serverTimestamp();
    await saveOp(
      () => (wasEditing ? updateDoc(doc(db, "transfers", editingTransferId), payload) : addDoc(collection(db, "transfers"), payload)),
      async (confirmed) => {
        toast(wasEditing ? "Đã cập nhật" : (confirmed ? "Đã ghi nhận chuyển hàng" : "Đã ghi nhận (chưa có mạng — sẽ tự đồng bộ)"));
        resetTrfForm();
        await loadAndRenderKho(opKitchenId);
      }
    );
  });

  await Promise.all([loadAndRenderKho(opKitchenId), loadAndRenderOrderRequests()]);
}

function resetIngForm() {
  editingIngId = null;
  const f = $("#form-ing");
  if (!f) return;
  f.reset();
  $("#ing-date").value = todayISO();
  $("#btn-ing-cancel").hidden = true;
  ingReceiptCtl?.set("");
}

function resetTrfForm() {
  editingTransferId = null;
  const f = $("#form-trf");
  if (!f) return;
  f.reset();
  $("#trf-date").value = todayISO();
  $("#btn-trf-cancel").hidden = true;
}

async function loadAndRenderKho(opKitchenId = operatingKitchenId()) {
  const ingListEl = $('[data-bind="ing-list"]');
  const trfListEl = $('[data-bind="trf-list"]');
  const stockEl = $('[data-bind="stock-table"]');
  if (ingListEl) ingListEl.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  if (trfListEl) trfListEl.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  if (stockEl) stockEl.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  try {
    const from = addDays(todayISO(), -STOCK_WINDOW_DAYS);
    const to = todayISO();
    const [allIng, allTrf] = await Promise.all([fetchIngredientsByRange(from, to), fetchTransfersByRange(from, to)]);
    ingCacheGlobal = allIng.filter((r) => r.locationId === opKitchenId).sort((a, b) => (a.date < b.date ? 1 : -1));
    transferCacheGlobal = allTrf.filter((r) => r.fromLocationId === opKitchenId).sort((a, b) => (a.date < b.date ? 1 : -1));

    renderIngListUI();
    renderTrfListUI();

    if (stockEl) {
      const stock = {};
      ingCacheGlobal.forEach((r) => {
        const k = r.itemName + "||" + r.unit;
        stock[k] = stock[k] || { itemName: r.itemName, unit: r.unit, ton: 0 };
        stock[k].ton += r.qty || 0;
      });
      transferCacheGlobal.forEach((r) => {
        const k = r.itemName + "||" + r.unit;
        stock[k] = stock[k] || { itemName: r.itemName, unit: r.unit, ton: 0 };
        stock[k].ton -= r.qty || 0;
      });
      const rows = Object.values(stock).sort((a, b) => a.itemName.localeCompare(b.itemName));
      const lowRows = rows.filter((r) => {
        const th = itemCatalog[r.itemName]?.threshold;
        return th && r.ton < th;
      });
      const lowBannerHtml = lowRows.length ? `
        <div class="reminder-banner">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
          <span>Sắp hết ${lowRows.length} nguyên liệu: ${lowRows.map((r) => escapeHtml(r.itemName)).join(", ")}. Đặt/điều chỉnh ngưỡng cảnh báo ở mục Quản lý.</span>
        </div>` : "";
      stockEl.innerHTML = rows.length ? `
        ${lowBannerHtml}
        <table class="data-table">
          <thead><tr><th>Nguyên liệu</th><th>Đơn vị</th><th>Tồn hiện tại</th></tr></thead>
          <tbody>${rows.map((r) => {
            const th = itemCatalog[r.itemName]?.threshold;
            const isLow = th && r.ton < th;
            return `<tr class="${isLow ? "stock-row-low" : ""}"><td>${escapeHtml(r.itemName)}</td><td>${escapeHtml(r.unit)}</td><td><b>${fmtNum(r.ton)}</b>${isLow ? ` <span class="badge-warn">Sắp hết</span>` : ""}</td></tr>`;
          }).join("")}</tbody>
        </table>
        <p class="hint-text">Tồn kho tính trong ${STOCK_WINDOW_DAYS} ngày gần nhất (nhập − đã chuyển đi).</p>
      ` : emptyState("Chưa có dữ liệu tồn kho");
    }
  } catch (err) {
    console.error(err);
    if (ingListEl) ingListEl.innerHTML = emptyState("Không tải được");
    if (trfListEl) trfListEl.innerHTML = emptyState("Không tải được");
    if (stockEl) stockEl.innerHTML = emptyState("Không tải được");
  }
}

function renderOrderCards(rows, forKitchen) {
  if (!rows.length) return "";
  const statusBadge = (st) => {
    if (st === "xong") return `<span class="badge-paid">Đã chuyển</span>`;
    if (st === "huy") return `<span class="entry-off-badge">Đã huỷ</span>`;
    return `<span class="badge-unpaid">Chờ xử lý</span>`;
  };
  return rows.map((r) => `
    <div class="ing-card" data-id="${r.id}">
      <div class="entry-card-top">
        <span class="entry-date">${formatDateVN(r.date)}${forKitchen ? " · " + escapeHtml(locationName(r.locationId)) : ""}</span>
        ${statusBadge(r.status)}
      </div>
      <div class="entry-meta"><span>${escapeHtml(r.itemName)}: <b>${fmtNum(r.qty)} ${escapeHtml(r.unit)}</b></span></div>
      ${r.ghiChu ? `<div class="entry-note">${escapeHtml(r.ghiChu)}</div>` : ""}
      ${forKitchen && r.status === "moi" ? `
      <div class="entry-row-actions">
        <button class="link-btn" data-order-fill="${r.id}">Điền vào form chuyển hàng</button>
        <button class="link-btn" data-order-done="${r.id}">Đã chuyển</button>
      </div>` : ""}
      ${!forKitchen && r.status === "moi" ? `
      <div class="entry-row-actions">
        <button class="link-btn danger" data-order-cancel="${r.id}">Huỷ đơn</button>
      </div>` : ""}
    </div>
  `).join("");
}

async function loadAndRenderMyOrders() {
  const el = $('[data-bind="order-list"]');
  if (el) el.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  try {
    const from = addDays(todayISO(), -STOCK_WINDOW_DAYS);
    const to = addDays(todayISO(), 30);
    const all = await fetchOrdersByRange(from, to);
    ordersCacheGlobal = all
      .filter((r) => r.locationId === profile.locationId)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    if (el) el.innerHTML = renderOrderCards(ordersCacheGlobal.slice(0, 40), false) || emptyState("Bạn chưa đặt hàng nguyên liệu nào");
  } catch (err) {
    console.error(err);
    if (el) el.innerHTML = emptyState("Không tải được");
  }
}

async function loadAndRenderReceived() {
  const el = $('[data-bind="received-list"]');
  if (el) el.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  try {
    const from = addDays(todayISO(), -STOCK_WINDOW_DAYS);
    const to = todayISO();
    const allTrf = await fetchTransfersByRange(from, to);
    const mine = allTrf
      .filter((r) => r.toLocationId === profile.locationId)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 40);
    if (el) el.innerHTML = renderTransferCards(mine, false) || emptyState("Chưa nhận hàng nào từ bếp trung tâm");
  } catch (err) {
    console.error(err);
    if (el) el.innerHTML = emptyState("Không tải được");
  }
}

async function loadAndRenderOrderRequests() {
  const el = $('[data-bind="order-requests-list"]');
  if (!el) return;
  el.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  try {
    const from = addDays(todayISO(), -STOCK_WINDOW_DAYS);
    const to = addDays(todayISO(), 30);
    const all = await fetchOrdersByRange(from, to);
    ordersCacheGlobal = all
      .filter((r) => r.status !== "huy" && r.status !== "xong")
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    el.innerHTML = renderOrderCards(ordersCacheGlobal, true) || emptyState("Chưa có yêu cầu nguyên liệu nào từ điểm bán");
  } catch (err) {
    console.error(err);
    el.innerHTML = emptyState("Không tải được");
  }
}

function renderIngCards(rows) {
  if (!rows.length) return "";
  return rows.map((r) => `
    <div class="ing-card" data-id="${r.id}">
      <div class="entry-card-top">
        <span class="entry-date">${formatDateVN(r.date)}</span>
        <span class="entry-total">${fmt(r.tien)}</span>
      </div>
      <div class="entry-meta">
        <span>${escapeHtml(r.itemName)}: <b>${fmtNum(r.qty)} ${escapeHtml(r.unit)}</b></span>
      </div>
      ${r.ghiChu ? `<div class="entry-note">${escapeHtml(r.ghiChu)}</div>` : ""}
      ${receiptThumbHtml(r.anhHoaDon)}
      <div class="entry-row-actions">
        <button class="link-btn" data-ing-edit="${r.id}">Sửa</button>
        <button class="link-btn danger" data-ing-del="${r.id}">Xoá</button>
      </div>
    </div>
  `).join("");
}

function renderTransferCards(rows, showActions) {
  if (!rows.length) return "";
  return rows.map((r) => `
    <div class="ing-card" data-id="${r.id}">
      <div class="entry-card-top">
        <span class="entry-date">${formatDateVN(r.date)}${showActions ? " · " + escapeHtml(locationName(r.toLocationId)) : ""}</span>
        <span class="entry-total">${fmtNum(r.qty)} ${escapeHtml(r.unit)}</span>
      </div>
      <div class="entry-meta"><span>${escapeHtml(r.itemName)}${!showActions ? " · từ " + escapeHtml(locationName(r.fromLocationId)) : ""}</span></div>
      ${r.ghiChu ? `<div class="entry-note">${escapeHtml(r.ghiChu)}</div>` : ""}
      ${showActions ? `
      <div class="entry-row-actions">
        <button class="link-btn" data-trf-edit="${r.id}">Sửa</button>
        <button class="link-btn danger" data-trf-del="${r.id}">Xoá</button>
      </div>` : ""}
    </div>
  `).join("");
}

function renderIngListUI() {
  const el = $('[data-bind="ing-list"]');
  const moreEl = $('[data-bind="ing-list-more"]');
  if (!el) return;
  const term = $("#ing-search")?.value.trim() || "";
  const filtered = ingCacheGlobal.filter((r) => matchesSearch(r, term, ["itemName", "ghiChu"]));
  el.innerHTML = renderIngCards(filtered.slice(0, ingListLimit)) || emptyState(term ? "Không tìm thấy nguyên liệu nào khớp" : `Chưa có nguyên liệu nhập trong ${STOCK_WINDOW_DAYS} ngày qua`);
  if (moreEl) moreEl.hidden = filtered.length <= ingListLimit;
}

function renderTrfListUI() {
  const el = $('[data-bind="trf-list"]');
  const moreEl = $('[data-bind="trf-list-more"]');
  if (!el) return;
  const term = $("#trf-search")?.value.trim() || "";
  const filtered = term
    ? transferCacheGlobal.filter((r) => matchesSearch(r, term, ["itemName", "ghiChu"]) || locationName(r.toLocationId).toLowerCase().includes(term.toLowerCase()))
    : transferCacheGlobal;
  el.innerHTML = renderTransferCards(filtered.slice(0, trfListLimit), true) || emptyState(term ? "Không tìm thấy lần chuyển hàng nào khớp" : "Chưa chuyển hàng cho điểm bán nào");
  if (moreEl) moreEl.hidden = filtered.length <= trfListLimit;
}

/* ===================== THU & CHI ===================== */
let thuChiCacheGlobal = [];

function thuChiDatalistHtml() {
  return `<datalist id="thuchi-suggestions">${THU_CHI_CATEGORIES.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("")}</datalist>`;
}

function tcLocationLabel(id) { return id ? locationName(id) : "Chung (toàn quán)"; }

async function renderThuChi() {
  mount("thu-chi");
  editingThuChiId = null;
  tcListLimit = 30;
  viewRoot.insertAdjacentHTML("beforeend", thuChiDatalistHtml());

  $("#tc-date").value = todayISO();
  $("#tc-loai").value = "chi";
  tcReceiptCtl = wireReceiptInput("tc-anh", "tc-anh-row", "tc-anh-preview", "tc-anh-clear");

  const locOptionsHtml = `<option value="">Chung (toàn quán)</option>` + activeLocations()
    .map(([id, l]) => `<option value="${id}">${escapeHtml(l.name)}${l.type === "kitchen" ? " (bếp)" : ""}</option>`).join("");
  $("#tc-location").innerHTML = locOptionsHtml;
  $("#tc-filter-location").innerHTML = `<option value="">Tất cả điểm</option>` + activeLocations()
    .map(([id, l]) => `<option value="${id}">${escapeHtml(l.name)}${l.type === "kitchen" ? " (bếp)" : ""}</option>`).join("");

  const fromEl = $("#tc-from"), toEl = $("#tc-to");
  const wkStart = mondayOf(todayISO());
  fromEl.value = wkStart;
  toEl.value = addDays(wkStart, 6);

  $$("#tc-presets .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const p = chip.dataset.preset;
      const today = todayISO();
      if (p === "week") { fromEl.value = mondayOf(today); toEl.value = addDays(mondayOf(today), 6); }
      else if (p === "month") { fromEl.value = today.slice(0, 8) + "01"; toEl.value = today; }
      else if (p === "7") { fromEl.value = addDays(today, -6); toEl.value = today; }
      loadAndRenderThuChi();
    });
  });
  fromEl.addEventListener("change", loadAndRenderThuChi);
  toEl.addEventListener("change", loadAndRenderThuChi);
  $("#tc-filter-loai").addEventListener("change", () => { tcListLimit = 30; renderThuChiFiltered(); });
  $("#tc-filter-location").addEventListener("change", () => { tcListLimit = 30; renderThuChiFiltered(); });
  $("#tc-search").addEventListener("input", () => { tcListLimit = 30; renderThuChiFiltered(); });
  $('[data-bind="tc-list-more"]').addEventListener("click", () => { tcListLimit += 30; renderThuChiFiltered(); });

  $("#btn-tc-cancel").addEventListener("click", () => resetThuChiForm());

  $("#form-thuchi").addEventListener("submit", async (e) => {
    e.preventDefault();
    const soTien = parseFloat($("#tc-sotien").value) || 0;
    const danhMuc = $("#tc-danhmuc").value.trim();
    if (!danhMuc) { toast("Nhập danh mục"); return; }
    if (soTien <= 0) { toast("Nhập số tiền lớn hơn 0"); return; }
    const payload = {
      uid: currentUser.uid,
      name: profile.name,
      loai: $("#tc-loai").value === "thu" ? "thu" : "chi",
      date: $("#tc-date").value,
      danhMuc,
      soTien,
      locationId: $("#tc-location").value || "",
      ghiChu: $("#tc-ghichu").value.trim(),
      anhHoaDon: tcReceiptCtl ? tcReceiptCtl.get() : "",
      updatedAt: serverTimestamp(),
    };
    const wasEditing = !!editingThuChiId;
    if (!wasEditing) payload.createdAt = serverTimestamp();
    await saveOp(
      () => (wasEditing ? updateDoc(doc(db, "thuchi", editingThuChiId), payload) : addDoc(collection(db, "thuchi"), payload)),
      async (confirmed) => {
        toast(wasEditing ? "Đã cập nhật giao dịch" : (confirmed ? "Đã lưu giao dịch" : "Đã lưu (chưa có mạng — sẽ tự đồng bộ)"));
        resetThuChiForm();
        await loadAndRenderThuChi();
      }
    );
  });

  await loadAndRenderThuChi();
}

function resetThuChiForm() {
  editingThuChiId = null;
  const f = $("#form-thuchi");
  if (!f) return;
  f.reset();
  $("#tc-date").value = todayISO();
  $("#tc-loai").value = "chi";
  $("#btn-tc-cancel").hidden = true;
  tcReceiptCtl?.set("");
}

async function loadAndRenderThuChi() {
  const listEl = $('[data-bind="tc-list"]');
  const sumEl = $('[data-bind="tc-summary"]');
  if (listEl) listEl.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  if (sumEl) sumEl.innerHTML = `<div class="stat-card"><div class="label">Đang tải…</div></div>`;
  const from = $("#tc-from").value, to = $("#tc-to").value;
  try {
    thuChiCacheGlobal = await fetchThuChiByRange(from, to);
    renderThuChiFiltered();
  } catch (err) {
    console.error(err);
    if (listEl) listEl.innerHTML = emptyState("Không tải được dữ liệu");
    if (sumEl) sumEl.innerHTML = `<div class="stat-card"><div class="label">Lỗi tải dữ liệu</div></div>`;
  }
}

function renderThuChiFiltered() {
  const loaiFilter = $("#tc-filter-loai").value;
  const locFilter = $("#tc-filter-location").value;
  const term = $("#tc-search")?.value.trim() || "";
  let rows = thuChiCacheGlobal;
  if (loaiFilter) rows = rows.filter((r) => r.loai === loaiFilter);
  if (locFilter) rows = rows.filter((r) => r.locationId === locFilter);
  if (term) rows = rows.filter((r) => matchesSearch(r, term, ["danhMuc", "ghiChu"]));

  const tongThu = rows.filter((r) => r.loai === "thu").reduce((s, r) => s + (r.soTien || 0), 0);
  const tongChi = rows.filter((r) => r.loai === "chi").reduce((s, r) => s + (r.soTien || 0), 0);
  const chenhLech = tongThu - tongChi;
  const sumEl = $('[data-bind="tc-summary"]');
  if (sumEl) {
    sumEl.innerHTML = `
      <div class="stat-card gold"><div class="label">Tổng thu</div><div class="value">${fmt(tongThu)}</div></div>
      <div class="stat-card accent"><div class="label">Tổng chi</div><div class="value">${fmt(tongChi)}</div></div>
      <div class="stat-card"><div class="label">Chênh lệch</div><div class="value">${fmt(chenhLech)}</div></div>
    `;
  }

  const sorted = [...rows].sort((a, b) => (a.date < b.date ? 1 : -1));
  const listEl = $('[data-bind="tc-list"]');
  if (listEl) listEl.innerHTML = renderThuChiCards(sorted.slice(0, tcListLimit)) || emptyState("Không có giao dịch nào trong khoảng này");
  const moreEl = $('[data-bind="tc-list-more"]');
  if (moreEl) moreEl.hidden = sorted.length <= tcListLimit;
}

function renderThuChiCards(rows) {
  if (!rows.length) return "";
  return rows.map((r) => `
    <div class="entry-card" data-id="${r.id}">
      <div class="entry-card-top">
        <span class="entry-date">${formatDateVN(r.date)} · ${escapeHtml(r.name || staffName(r.uid))}</span>
        <span class="${r.loai === "thu" ? "entry-total" : "entry-off-badge"}">${r.loai === "thu" ? "+" : "-"}${fmt(r.soTien)}</span>
      </div>
      <div class="entry-meta">
        <span>${escapeHtml(r.danhMuc)}</span>
        <span>${escapeHtml(tcLocationLabel(r.locationId))}</span>
      </div>
      ${r.ghiChu ? `<div class="entry-note">${escapeHtml(r.ghiChu)}</div>` : ""}
      ${receiptThumbHtml(r.anhHoaDon)}
      <div class="entry-row-actions">
        <button class="link-btn" data-tc-edit="${r.id}">Sửa</button>
        <button class="link-btn danger" data-tc-del="${r.id}">Xoá</button>
      </div>
    </div>
  `).join("");
}

/* ===================== BÁO CÁO ===================== */
async function renderBaoCao() {
  mount("bao-cao");
  const fromEl = $("#report-from"), toEl = $("#report-to");
  const wkStart = mondayOf(todayISO());
  fromEl.value = wkStart;
  toEl.value = addDays(wkStart, 5);

  const locSel = $("#report-location");
  locSel.innerHTML = `<option value="">Tất cả điểm</option>` + activeLocations()
    .map(([id, l]) => `<option value="${id}">${escapeHtml(l.name)}${l.type === "kitchen" ? " (bếp)" : ""}</option>`).join("");
  locSel.addEventListener("change", loadReport);

  $$("#report-presets .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const p = chip.dataset.preset;
      const today = todayISO();
      if (p === "week") { fromEl.value = mondayOf(today); toEl.value = addDays(mondayOf(today), 5); }
      else if (p === "month") { fromEl.value = today.slice(0, 8) + "01"; toEl.value = today; }
      else if (p === "7") { fromEl.value = addDays(today, -6); toEl.value = today; }
      loadReport();
    });
  });
  fromEl.addEventListener("change", loadReport);
  toEl.addEventListener("change", loadReport);
  $("#btn-export-csv").addEventListener("click", exportCsv);
  $("#btn-export-pdf").addEventListener("click", () => window.print());

  await loadReport();
}

let reportEntriesCache = [];
let reportIngCache = [];
let reportThuChiCache = [];

async function loadReport() {
  const from = $("#report-from").value, to = $("#report-to").value;
  const locFilter = $("#report-location").value;
  const sumEl = $('[data-bind="report-summary"]');
  sumEl.innerHTML = `<div class="stat-card"><div class="label">Đang tải…</div></div>`;
  let giaVonPerPhan = 0;
  try {
    [reportEntriesCache, reportIngCache, reportThuChiCache, giaVonPerPhan] = await Promise.all([
      fetchEntriesByRange(from, to),
      fetchIngredientsByRange(from, to),
      fetchThuChiByRange(from, to),
      computeGiaVonPerPhan(),
    ]);
  } catch (err) {
    console.error(err);
    sumEl.innerHTML = `<div class="stat-card"><div class="label">Lỗi tải báo cáo</div></div>`;
    return;
  }

  const allWorked = reportEntriesCache.filter((r) => !r.offDay);
  const worked = locFilter ? allWorked.filter((r) => r.locationId === locFilter) : allWorked;

  const tongSoLuong = worked.reduce((s, r) => s + (r.soLuong || 0), 0);
  const doanhThu = worked.reduce((s, r) => s + (r.soLuong || 0) * locationGiaBan(r.locationId), 0);
  const luongThuong = worked.reduce((s, r) => s + (r.tong || 0), 0);

  const selectedIsPoint = locFilter && locationsDirectory[locFilter]?.type === "point";
  const ingScoped = locFilter ? reportIngCache.filter((r) => r.locationId === locFilter) : reportIngCache;
  const chiPhiNL = selectedIsPoint ? 0 : ingScoped.reduce((s, r) => s + (r.tien || 0), 0);
  // Đã đặt định mức nguyên liệu/phần ở Quản lý → phân bổ giá vốn NL theo số
  // lượng bán thực tế, áp dụng được cho cả từng điểm bán (không chỉ "Tất cả điểm").
  const coBOM = giaVonPerPhan > 0;
  const giaVonNLPhanBo = giaVonPerPhan * tongSoLuong;

  const tcScoped = locFilter ? reportThuChiCache.filter((r) => r.locationId === locFilter) : reportThuChiCache;
  const thuKhac = tcScoped.filter((r) => r.loai === "thu").reduce((s, r) => s + (r.soTien || 0), 0);
  const chiKhac = tcScoped.filter((r) => r.loai === "chi").reduce((s, r) => s + (r.soTien || 0), 0);

  const chiPhiNLDungTinhLoiNhuan = coBOM ? giaVonNLPhanBo : chiPhiNL;
  const loiNhuan = doanhThu - chiPhiNLDungTinhLoiNhuan - luongThuong + thuKhac - chiKhac;

  sumEl.innerHTML = `
    <div class="stat-card gold"><div class="label">Doanh thu ước tính</div><div class="value">${fmt(doanhThu)}</div></div>
    <div class="stat-card"><div class="label">Số lượng bán</div><div class="value">${fmtNum(tongSoLuong)}</div></div>
    ${coBOM
      ? `<div class="stat-card accent"><div class="label">Giá vốn NL (theo định mức)</div><div class="value">${fmt(giaVonNLPhanBo)}</div></div>`
      : `<div class="stat-card accent"><div class="label">Chi phí nguyên liệu${selectedIsPoint ? " (—)" : ""}</div><div class="value">${fmt(chiPhiNL)}</div></div>`}
    <div class="stat-card accent"><div class="label">Lương + thưởng</div><div class="value">${fmt(luongThuong)}</div></div>
    <div class="stat-card gold"><div class="label">Thu khác</div><div class="value">${fmt(thuKhac)}</div></div>
    <div class="stat-card accent"><div class="label">Chi khác</div><div class="value">${fmt(chiKhac)}</div></div>
    <div class="stat-card"><div class="label">Lợi nhuận ước tính</div><div class="value">${fmt(loiNhuan)}</div></div>
  `;
  if (coBOM) {
    sumEl.insertAdjacentHTML("beforeend", `<p class="hint-text" style="grid-column:1/-1;">Giá vốn NL ước tính = ${fmt(giaVonPerPhan)}/phần × số lượng bán, theo định mức đặt ở mục Quản lý — áp dụng được cho cả từng điểm bán.</p>`);
  } else if (selectedIsPoint) {
    sumEl.insertAdjacentHTML("beforeend", `<p class="hint-text" style="grid-column:1/-1;">Chi phí nguyên liệu phát sinh chung ở bếp trung tâm nên không chia theo từng điểm bán — xem ở lựa chọn "Tất cả điểm" hoặc điểm bếp. (Đặt định mức nguyên liệu/phần ở mục Quản lý để tự động phân bổ theo điểm.)</p>`);
  }

  renderByLocationTable(allWorked, reportIngCache, locFilter, giaVonPerPhan);
  renderByStaffTable(worked, !locFilter);
  renderDailyBarChart(worked, from, to);
  await renderMonthlyChart(locFilter, giaVonPerPhan);
  await renderSettlements(worked);
}

// Biểu đồ doanh thu + lợi nhuận ước tính theo tháng (6 tháng gần nhất), độc
// lập với khoảng ngày đang lọc ở trên để luôn thấy được xu hướng dài hạn.
async function renderMonthlyChart(locFilter, giaVonPerPhan = 0) {
  const el = $('[data-bind="report-monthly-chart"]');
  if (!el) return;
  el.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  const MONTHS_BACK = 6;
  try {
    const toStr = todayISO();
    const fromDate = new Date(toStr + "T00:00:00");
    fromDate.setMonth(fromDate.getMonth() - (MONTHS_BACK - 1));
    fromDate.setDate(1);
    const fromStr = isoLocal(fromDate);
    const rows = await fetchEntriesByRange(fromStr, toStr);
    const worked = rows.filter((r) => !r.offDay && (!locFilter || r.locationId === locFilter));

    const byMonth = {};
    worked.forEach((r) => {
      const m = r.date.slice(0, 7);
      byMonth[m] = byMonth[m] || { doanhThu: 0, luongThuong: 0, soLuong: 0 };
      byMonth[m].doanhThu += (r.soLuong || 0) * locationGiaBan(r.locationId);
      byMonth[m].luongThuong += r.tong || 0;
      byMonth[m].soLuong += r.soLuong || 0;
    });

    const months = [];
    const cursor = new Date(fromStr + "T00:00:00");
    for (let i = 0; i < MONTHS_BACK; i++) {
      months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    const dataRows = months.map((m) => {
      const d = byMonth[m] || { doanhThu: 0, luongThuong: 0, soLuong: 0 };
      const giaVonNL = giaVonPerPhan * d.soLuong;
      const loiNhuan = d.doanhThu - d.luongThuong - giaVonNL;
      return { month: m, ...d, loiNhuan };
    });
    const max = Math.max(1, ...dataRows.map((d) => d.doanhThu));

    el.innerHTML = `
      <p class="eyebrow">Doanh thu ${MONTHS_BACK} tháng gần nhất${giaVonPerPhan > 0 ? " (lợi nhuận đã trừ giá vốn NL theo định mức)" : ""}</p>
      ${dataRows.map((d) => `
        <div class="bar-row">
          <span class="bar-label">Th${d.month.slice(5, 7)}/${d.month.slice(2, 4)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${Math.max(3, (d.doanhThu / max) * 100)}%"></span></span>
          <span class="bar-value">${fmtNum(d.doanhThu)}</span>
        </div>
      `).join("")}
      <p class="hint-text">Lợi nhuận ước tính theo tháng: ${dataRows.map((d) => `Th${d.month.slice(5, 7)}: ${fmt(d.loiNhuan)}`).join(" · ")}</p>
    `;
  } catch (err) {
    console.error(err);
    el.innerHTML = emptyState("Không tải được biểu đồ theo tháng");
  }
}

function renderByLocationTable(allWorked, allIng, locFilter, giaVonPerPhan = 0) {
  const el = $('[data-bind="report-by-location"]');
  const wrap = $('[data-bind="report-by-location-wrap"]');
  if (!el || !wrap) return;
  if (locFilter) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const groups = {};
  allWorked.forEach((r) => {
    const id = r.locationId || "__none";
    groups[id] = groups[id] || { name: locationName(r.locationId), soLuong: 0, doanhThu: 0, luongThuong: 0 };
    groups[id].soLuong += r.soLuong || 0;
    groups[id].doanhThu += (r.soLuong || 0) * locationGiaBan(r.locationId);
    groups[id].luongThuong += r.tong || 0;
  });
  const rows = Object.values(groups).sort((a, b) => b.doanhThu - a.doanhThu);
  if (!rows.length) { el.innerHTML = emptyState("Chưa có dữ liệu"); return; }
  const chiPhiNLTong = allIng.reduce((s, r) => s + (r.tien || 0), 0);
  const coBOM = giaVonPerPhan > 0;
  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Điểm bán</th><th>Số lượng</th><th>Doanh thu</th><th>Lương+thưởng</th>${coBOM ? "<th>Giá vốn NL</th>" : ""}<th>Lãi ước tính${coBOM ? "" : " (chưa trừ NL)"}</th></tr></thead>
      <tbody>
        ${rows.map((g) => {
          const giaVonNL = coBOM ? giaVonPerPhan * g.soLuong : 0;
          const lai = g.doanhThu - g.luongThuong - giaVonNL;
          return `<tr><td>${escapeHtml(g.name)}</td><td>${fmtNum(g.soLuong)}</td><td>${fmt(g.doanhThu)}</td><td>${fmt(g.luongThuong)}</td>${coBOM ? `<td>${fmt(giaVonNL)}</td>` : ""}<td><b>${fmt(lai)}</b></td></tr>`;
        }).join("")}
      </tbody>
    </table>
    <p class="hint-text">Chi phí nguyên liệu thực nhập toàn hệ thống (bếp trung tâm): <b>${fmt(chiPhiNLTong)}</b>${coBOM ? " — dùng để đối chiếu với giá vốn ước tính theo định mức ở bảng trên." : " — chưa phân bổ vào từng điểm ở bảng trên (đặt định mức nguyên liệu/phần ở mục Quản lý để tự động phân bổ)."}</p>
  `;
}

function renderByStaffTable(worked, showLocationCol) {
  const groups = {};
  worked.forEach((r) => {
    groups[r.uid + "_" + (r.locationId || "")] = groups[r.uid + "_" + (r.locationId || "")] || {
      name: r.name || staffName(r.uid), locationId: r.locationId, soNgay: 0, soLuong: 0, luong: 0, thuong: 0, tong: 0,
    };
    const g = groups[r.uid + "_" + (r.locationId || "")];
    g.soNgay++; g.soLuong += r.soLuong || 0; g.luong += r.luong || 0; g.thuong += r.thuong || 0; g.tong += r.tong || 0;
  });
  const rows = Object.values(groups).sort((a, b) => b.tong - a.tong);
  const el = $('[data-bind="report-by-staff"]');
  if (!rows.length) { el.innerHTML = emptyState("Chưa có phiếu chấm công trong khoảng này"); return; }
  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Nhân viên</th>${showLocationCol ? "<th>Điểm bán</th>" : ""}<th>Ngày làm</th><th>Số lượng</th><th>Lương</th><th>Thưởng</th><th>Tổng nhận</th></tr></thead>
      <tbody>
        ${rows.map((g) => `<tr><td>${escapeHtml(g.name)}</td>${showLocationCol ? `<td>${escapeHtml(locationName(g.locationId))}</td>` : ""}<td>${g.soNgay}</td><td>${fmtNum(g.soLuong)}</td><td>${fmt(g.luong)}</td><td>${fmt(g.thuong)}</td><td><b>${fmt(g.tong)}</b></td></tr>`).join("")}
      </tbody>
    </table>
  `;
}

function renderDailyBarChart(worked, from, to) {
  const byDay = {};
  worked.forEach((r) => { byDay[r.date] = (byDay[r.date] || 0) + (r.soLuong || 0) * locationGiaBan(r.locationId); });
  const days = [];
  let d = from;
  let guard = 0;
  while (d <= to && guard < 62) { days.push(d); d = addDays(d, 1); guard++; }
  const max = Math.max(1, ...days.map((x) => byDay[x] || 0));
  const chartInner = days.map((x) => `
    <div class="bar-row">
      <span class="bar-label">${weekdayLabel(x)} ${x.slice(8, 10)}/${x.slice(5, 7)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(3, ((byDay[x] || 0) / max) * 100)}%"></span></span>
      <span class="bar-value">${fmtNum(byDay[x] || 0)}</span>
    </div>`).join("");

  let chartBox = document.getElementById("daily-chart-box");
  if (!chartBox) {
    const el = $('[data-bind="report-by-staff"]');
    el.insertAdjacentHTML("afterend", `<div class="ticket" id="daily-chart-box" style="margin-top:14px;"><p class="eyebrow">Doanh thu theo ngày</p><div id="daily-chart-inner"></div></div>`);
    chartBox = document.getElementById("daily-chart-box");
  }
  document.getElementById("daily-chart-inner").innerHTML = chartInner;
}

async function renderSettlements(entries) {
  const groups = {};
  entries.forEach((r) => {
    const wk = mondayOf(r.date);
    const key = r.uid + "_" + wk;
    groups[key] = groups[key] || { uid: r.uid, name: r.name || staffName(r.uid), week: wk, total: 0 };
    groups[key].total += r.tong || 0;
  });
  const keys = Object.keys(groups);
  const el = $('[data-bind="report-settlements"]');
  if (!keys.length) { el.innerHTML = emptyState("Không có tuần nào để quyết toán trong khoảng đã chọn"); return; }

  let settlementDocs = {};
  try {
    const results = await Promise.all(keys.map((k) => getDoc(doc(db, "settlements", k))));
    results.forEach((snap, i) => { if (snap.exists()) settlementDocs[keys[i]] = snap.data(); });
  } catch (err) { console.error(err); }

  el.innerHTML = keys.sort().map((k) => {
    const g = groups[k];
    const s = settlementDocs[k] || { paid: false, adjustment: 0, note: "" };
    const weekEnd = addDays(g.week, 5);
    const finalTotal = g.total + (s.adjustment || 0);
    return `
      <div class="settlement-card" data-key="${k}" data-uid="${g.uid}" data-week="${g.week}">
        <div class="settlement-top">
          <div>
            <div class="settlement-name">${escapeHtml(g.name)}</div>
            <div class="settlement-week">Tuần ${g.week.slice(8,10)}/${g.week.slice(5,7)} – ${weekEnd.slice(8,10)}/${weekEnd.slice(5,7)}</div>
          </div>
          <span class="${s.paid ? "badge-paid" : "badge-unpaid"}">${s.paid ? "Đã thanh toán" : "Chưa thanh toán"}</span>
        </div>
        <div class="settlement-adj">
          <label class="field"><span>Tổng phiếu (đ)</span><input type="text" value="${fmtNum(g.total)}" disabled /></label>
          <label class="field"><span>Điều chỉnh (+/-)</span><input type="number" class="settle-adj" value="${s.adjustment || 0}" step="1000" /></label>
        </div>
        <label class="field"><span>Ghi chú</span><input type="text" class="settle-note" value="${escapeHtml(s.note || "")}" placeholder="VD: giữ lại 100k tiền thối" /></label>
        <div class="settlement-total">Thực nhận: ${fmt(finalTotal)}</div>
        <label class="paid-toggle"><input type="checkbox" class="settle-paid" ${s.paid ? "checked" : ""} /> Đã thanh toán tuần này</label>
      </div>
    `;
  }).join("");

  $$(".settlement-card", el).forEach((card) => {
    const save = async () => {
      const key = card.dataset.key;
      const adj = parseFloat($(".settle-adj", card).value) || 0;
      const note = $(".settle-note", card).value.trim();
      const paid = $(".settle-paid", card).checked;
      try {
        await setDoc(doc(db, "settlements", key), {
          uid: card.dataset.uid, name: staffName(card.dataset.uid) || "", week: card.dataset.week,
          adjustment: adj, note, paid, updatedAt: serverTimestamp(),
        }, { merge: true });
        toast("Đã lưu quyết toán");
        $(".badge-paid, .badge-unpaid", card)?.remove();
        const badge = document.createElement("span");
        badge.className = paid ? "badge-paid" : "badge-unpaid";
        badge.textContent = paid ? "Đã thanh toán" : "Chưa thanh toán";
        $(".settlement-top", card).appendChild(badge);
      } catch (err) { console.error(err); toast("Không lưu được quyết toán"); }
    };
    $(".settle-adj", card).addEventListener("change", () => {
      const base = parseFloat($(".field input[disabled]", card).value.replace(/\./g, "")) || 0;
      const adj = parseFloat($(".settle-adj", card).value) || 0;
      $(".settlement-total", card).textContent = "Thực nhận: " + fmt(base + adj);
      save();
    });
    $(".settle-note", card).addEventListener("change", save);
    $(".settle-paid", card).addEventListener("change", save);
  });
}

function exportCsv() {
  const from = $("#report-from").value, to = $("#report-to").value;
  const locFilter = $("#report-location").value;
  const rows = [["Ngày", "Điểm bán", "Nhân viên", "Lương", "Số lượng", "Thưởng", "Tổng", "Ship", "Xôi ship/dẹp", "Ghi chú"]];
  reportEntriesCache.filter((r) => !locFilter || r.locationId === locFilter).forEach((r) => {
    rows.push([r.date, locationName(r.locationId), r.name || staffName(r.uid), r.offDay ? "Nghỉ" : r.luong, r.offDay ? "" : r.soLuong,
      r.offDay ? "" : r.thuong, r.offDay ? 0 : r.tong, r.ship || "", r.dep || "", (r.ghiChu || "").replace(/\n/g, " ")]);
  });
  const csv = "\uFEFF" + rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `so-xoi_${from}_den_${to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ===================== QUẢN LÝ (Điểm bán + Nhân viên) ===================== */
async function renderQuanLy() {
  mount("quan-ly");

  $("#form-location").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: $("#loc-name").value.trim(),
      type: $("#loc-type").value,
      address: $("#loc-address").value.trim(),
      giaBan: parseFloat($("#loc-giaban").value) || 0,
      luongMacDinh: parseFloat($("#loc-luong").value) || 0,
      updatedAt: serverTimestamp(),
    };
    if (!payload.name) { toast("Nhập tên điểm"); return; }
    try {
      if (editingLocationId) {
        await updateDoc(doc(db, "locations", editingLocationId), payload);
        toast("Đã cập nhật điểm bán");
      } else {
        payload.active = true;
        payload.createdAt = serverTimestamp();
        await addDoc(collection(db, "locations"), payload);
        toast("Đã thêm điểm bán");
      }
      resetLocationForm();
      await loadLocationsDirectory();
      renderLocationList();
      populateStaffLocationSelect();
    } catch (err) { console.error(err); toast("Không lưu được điểm bán"); }
  });
  $("#btn-loc-cancel").addEventListener("click", () => resetLocationForm());

  const cleanAllBtn = $("#btn-clean-all-test");
  if (cleanAllBtn) {
    cleanAllBtn.addEventListener("click", async () => {
      if (!confirm("Xoá TOÀN BỘ dữ liệu test (phiếu chấm công, nhập kho, chuyển hàng, thu chi của nhân viên TEST NV hoặc gắn với điểm bán đã xoá, và các tài khoản TEST NV)? Không thể hoàn tác.")) return;
      cleanAllBtn.disabled = true;
      try {
        const validLocIds = new Set(Object.keys(locationsDirectory));
        const testStaffUids = new Set(
          Object.entries(staffDirectory)
            .filter(([, u]) => (u.name || "").trim().toUpperCase().startsWith("TEST NV"))
            .map(([uid]) => uid)
        );

        let deletedCount = 0;

        const entriesSnap = await getDocs(collection(db, "entries"));
        for (const d of entriesSnap.docs) {
          const r = d.data();
          if (testStaffUids.has(r.uid) || (r.name || "").trim().toUpperCase().startsWith("TEST NV") || (r.locationId && !validLocIds.has(r.locationId))) {
            await deleteDoc(doc(db, "entries", d.id));
            deletedCount++;
          }
        }

        const ingSnap = await getDocs(collection(db, "ingredients"));
        for (const d of ingSnap.docs) {
          const r = d.data();
          if (r.locationId && !validLocIds.has(r.locationId)) {
            await deleteDoc(doc(db, "ingredients", d.id));
            deletedCount++;
          }
        }

        const trfSnap = await getDocs(collection(db, "transfers"));
        for (const d of trfSnap.docs) {
          const r = d.data();
          if ((r.fromLocationId && !validLocIds.has(r.fromLocationId)) || (r.toLocationId && !validLocIds.has(r.toLocationId))) {
            await deleteDoc(doc(db, "transfers", d.id));
            deletedCount++;
          }
        }

        const tcSnap = await getDocs(collection(db, "thuchi"));
        for (const d of tcSnap.docs) {
          const r = d.data();
          if (r.locationId && !validLocIds.has(r.locationId)) {
            await deleteDoc(doc(db, "thuchi", d.id));
            deletedCount++;
          }
        }

        for (const uid of testStaffUids) {
          await deleteDoc(doc(db, "users", uid));
          deletedCount++;
        }

        toast(`Đã dọn ${deletedCount} bản ghi test`);
        await Promise.all([loadStaffDirectory(), loadLocationsDirectory()]);
        renderLocationList();
        renderStaffList();
        populateStaffLocationSelect();
      } catch (err) {
        console.error(err);
        toast("Không dọn hết được: " + (err.message || ""));
      } finally {
        cleanAllBtn.disabled = false;
      }
    });
  }
  const cleanTestBtn = $("#btn-loc-clean-test");
  if (cleanTestBtn) {
    cleanTestBtn.addEventListener("click", async () => {
      const testEntries = Object.entries(locationsDirectory).filter(([, l]) => (l.name || "").trim().toUpperCase().startsWith("TEST"));
      if (!testEntries.length) { toast("Không có điểm nào tên bắt đầu bằng TEST"); return; }
      if (!confirm(`Xoá ${testEntries.length} điểm bán có tên bắt đầu bằng "TEST"? Không thể hoàn tác.`)) return;
      cleanTestBtn.disabled = true;
      try {
        await Promise.all(testEntries.map(([id]) => deleteDoc(doc(db, "locations", id))));
        toast(`Đã xoá ${testEntries.length} điểm TEST`);
        await loadLocationsDirectory();
        renderLocationList();
        populateStaffLocationSelect();
      } catch (err) {
        console.error(err);
        toast("Không xoá hết được: " + (err.message || ""));
      } finally {
        cleanTestBtn.disabled = false;
      }
    });
  }

  $("#form-staff").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#staff-name").value.trim();
    const email = $("#staff-email").value.trim();
    const role = $("#staff-role").value;
    const staffLocationId = $("#staff-location").value;
    if (!staffLocationId) { toast("Chọn điểm bán cho nhân viên"); return; }
    const btn = e.submitter;
    btn.disabled = true;
    try {
      // Không cần chủ quán gõ/lộ mật khẩu tạm: tự sinh 1 mật khẩu ngẫu nhiên
      // nội bộ chỉ để thoả điều kiện tạo tài khoản, rồi gửi ngay email đặt
      // lại mật khẩu cho nhân viên tự chọn mật khẩu của họ.
      const tempPassword = "Xoi-" + Math.random().toString(36).slice(2, 10) + "!" + Math.floor(Math.random() * 100);
      const secondary = initializeApp(firebaseConfig, "Secondary-" + Date.now());
      const secondaryAuth = getAuth(secondary);
      try {
        const cred = await createUserWithEmailAndPassword(secondaryAuth, email, tempPassword);
        await setDoc(doc(db, "users", cred.user.uid), {
          name, role, email, locationId: staffLocationId, active: true, createdAt: serverTimestamp(),
        });
        await signOut(secondaryAuth);
      } finally {
        await deleteApp(secondary);
      }
      try {
        await sendPasswordResetEmail(auth, email);
        toast(`Đã tạo tài khoản cho ${name} và gửi email đặt mật khẩu tới ${email}`);
      } catch (mailErr) {
        console.error(mailErr);
        toast(`Đã tạo tài khoản cho ${name}, nhưng gửi email đặt mật khẩu thất bại — bấm "Gửi lại email đổi mật khẩu" ở danh sách bên dưới để thử lại.`);
      }
      $("#form-staff").reset();
      await loadStaffDirectory();
      renderStaffList();
    } catch (err) {
      console.error(err);
      toast(err.code === "auth/email-already-in-use" ? "Email đã được sử dụng" : "Không tạo được tài khoản");
    } finally {
      btn.disabled = false;
    }
  });

  populateStaffLocationSelect();
  renderLocationList();
  await loadStaffDirectory();
  renderStaffList();
  await renderItemCatalogSection();
}

async function renderItemCatalogSection() {
  const el = $('[data-bind="catalog-table"]');
  const sumEl = $('[data-bind="catalog-cost-summary"]');
  if (!el) return;
  el.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  try {
    const from = addDays(todayISO(), -STOCK_WINDOW_DAYS);
    const ingRows = await fetchIngredientsByRange(from, todayISO());
    const costMap = avgUnitCostMap(ingRows);
    const names = new Set([...Object.keys(itemCatalog), ...Object.keys(costMap), ...ITEM_SUGGESTIONS]);
    const rows = Array.from(names).filter(Boolean).sort((a, b) => a.localeCompare(b, "vi"));
    if (!rows.length) { el.innerHTML = emptyState("Chưa có nguyên liệu nào"); if (sumEl) sumEl.textContent = ""; return; }

    el.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Nguyên liệu</th><th>Đơn vị</th><th>Giá TB/đvị</th><th>Định mức/phần</th><th>Ngưỡng cảnh báo</th><th></th></tr></thead>
        <tbody>
          ${rows.map((name) => {
            const cat = itemCatalog[name] || {};
            const cost = costMap[name];
            const unit = cat.unit || (cost ? cost.unit : "") || "";
            return `<tr data-item="${escapeHtml(name)}" data-unit="${escapeHtml(unit)}">
              <td>${escapeHtml(name)}</td>
              <td>${escapeHtml(unit)}</td>
              <td>${cost && cost.avgCost ? fmt(cost.avgCost) : "—"}</td>
              <td><input type="number" class="cat-qty" min="0" step="0.01" value="${cat.qtyPerPortion ?? ""}" style="width:78px" /></td>
              <td><input type="number" class="cat-threshold" min="0" step="0.1" value="${cat.threshold ?? ""}" style="width:78px" /></td>
              <td><button type="button" class="link-btn cat-save">Lưu</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    `;

    $$(".cat-save", el).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tr = btn.closest("tr");
        const name = tr.dataset.item;
        const unit = tr.dataset.unit || $(".cat-qty", tr).closest("tr").children[1].textContent.trim();
        const qtyPerPortion = parseFloat($(".cat-qty", tr).value) || 0;
        const threshold = parseFloat($(".cat-threshold", tr).value) || 0;
        const existingId = itemCatalog[name]?.id || slugifyItemName(name);
        try {
          await setDoc(doc(db, "itemCatalog", existingId), {
            itemName: name, unit, qtyPerPortion, threshold, updatedAt: serverTimestamp(),
          });
          itemCatalog[name] = { id: existingId, itemName: name, unit, qtyPerPortion, threshold };
          toast("Đã lưu định mức: " + name);
          updateCatalogCostSummary(costMap);
        } catch (err) { console.error(err); toast("Không lưu được: " + (err.message || "")); }
      });
    });

    updateCatalogCostSummary(costMap);
  } catch (err) {
    console.error(err);
    el.innerHTML = emptyState("Không tải được dữ liệu");
  }

  function updateCatalogCostSummary(costMap) {
    if (!sumEl) return;
    let total = 0, count = 0;
    Object.entries(itemCatalog).forEach(([name, cat]) => {
      if (!cat.qtyPerPortion) return;
      const c = costMap[name];
      total += (cat.qtyPerPortion || 0) * (c ? c.avgCost : 0);
      count++;
    });
    sumEl.textContent = count
      ? `Giá vốn nguyên liệu ước tính / phần xôi (theo ${count} định mức đã đặt): ${fmt(total)} — dùng để phân bổ chi phí NL theo điểm bán trong Báo cáo.`
      : "Chưa đặt định mức nào — nhập số vào cột \"Định mức/phần\" rồi bấm Lưu để bắt đầu tính giá vốn.";
  }
}

function resetLocationForm() {
  editingLocationId = null;
  const f = $("#form-location");
  if (!f) return;
  f.reset();
  $("#btn-loc-cancel").hidden = true;
}

function populateStaffLocationSelect() {
  const sel = $("#staff-location");
  if (!sel) return;
  const locs = activeLocations();
  sel.innerHTML = locs.length
    ? locs.map(([id, l]) => `<option value="${id}">${escapeHtml(l.name)}${l.type === "kitchen" ? " (bếp)" : ""}</option>`).join("")
    : `<option value="">(chưa có điểm nào — thêm điểm bán trước)</option>`;
}

function renderLocationList() {
  const el = $('[data-bind="location-list"]');
  if (!el) return;
  const rows = Object.entries(locationsDirectory).sort((a, b) => (a[1].type === "kitchen" ? -1 : 1) - (b[1].type === "kitchen" ? -1 : 1));
  if (!rows.length) { el.innerHTML = emptyState("Chưa có điểm bán nào — thêm bếp trung tâm và các điểm bán ở form trên"); return; }
  el.innerHTML = rows.map(([id, l]) => `
    <div class="staff-card" data-id="${id}">
      <div class="entry-card-top">
        <span class="entry-date">${escapeHtml(l.name)}</span>
        <span class="${l.type === "kitchen" ? "badge-paid" : "badge-unpaid"}" style="background:${l.type === "kitchen" ? "var(--gold-tint)" : "var(--green-tint)"};color:${l.type === "kitchen" ? "var(--gold)" : "var(--green-dark)"}">${l.type === "kitchen" ? "Bếp trung tâm" : "Điểm bán"}</span>
      </div>
      <div class="entry-meta">
        <span>Giá bán: <b>${fmt(l.giaBan)}</b></span>
        <span>Lương mặc định: <b>${fmt(l.luongMacDinh)}</b></span>
        ${l.address ? `<span>${escapeHtml(l.address)}</span>` : ""}
      </div>
      ${l.active === false ? `<div class="entry-note">Đã ngừng hoạt động</div>` : ""}
      <div class="entry-row-actions">
        <button class="link-btn" data-loc-edit="${id}">Sửa</button>
        <button class="link-btn" data-loc-toggle="${id}">${l.active === false ? "Kích hoạt lại" : "Ngừng hoạt động"}</button>
        <button class="link-btn danger" data-loc-del="${id}">Xoá</button>
      </div>
    </div>
  `).join("");
}

function renderStaffList() {
  const el = $('[data-bind="staff-list"]');
  if (!el) return;
  const rows = Object.entries(staffDirectory).sort((a, b) => (a[1].role === "admin" ? -1 : 1));
  if (!rows.length) { el.innerHTML = emptyState("Chưa có nhân viên nào"); return; }
  el.innerHTML = rows.map(([uid, u]) => `
    <div class="staff-card" data-uid="${uid}">
      <div class="entry-card-top">
        <span class="entry-date">${escapeHtml(u.name || "(chưa đặt tên)")}</span>
        <span class="${u.role === "admin" ? "badge-paid" : "badge-unpaid"}" style="background:${u.role === "admin" ? "var(--gold-tint)" : "var(--green-tint)"};color:${u.role === "admin" ? "var(--gold)" : "var(--green-dark)"}">${u.role === "admin" ? "Chủ quán" : "Nhân viên"}</span>
      </div>
      <div class="entry-meta"><span>${escapeHtml(u.email || "")}</span><span>${escapeHtml(locationName(u.locationId))}</span></div>
      <div class="entry-row-actions">
        ${u.email ? `<button class="link-btn" data-resend-reset="${uid}">Gửi lại email đổi mật khẩu</button>` : ""}
        ${uid !== currentUser.uid ? `<button class="link-btn" data-toggle-active="${uid}">${u.active === false ? "Kích hoạt lại" : "Vô hiệu hoá"}</button>` : ""}
      </div>
      ${uid === currentUser.uid ? `<div class="entry-note">Tài khoản của bạn</div>` : ""}
    </div>
  `).join("");

  $$("[data-resend-reset]", el).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.resendReset;
      const u = staffDirectory[uid];
      if (!u?.email) return;
      try {
        await sendPasswordResetEmail(auth, u.email);
        toast("Đã gửi email đổi mật khẩu tới " + u.email);
      } catch (err) { console.error(err); toast("Không gửi được email"); }
    });
  });

  $$("[data-toggle-active]", el).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.toggleActive;
      const cur = staffDirectory[uid];
      try {
        await updateDoc(doc(db, "users", uid), { active: !(cur.active !== false) });
        toast("Đã cập nhật trạng thái");
        await loadStaffDirectory();
        renderStaffList();
      } catch (err) { console.error(err); toast("Không cập nhật được"); }
    });
  });
}
