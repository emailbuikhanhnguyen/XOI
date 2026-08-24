import { firebaseConfig } from "./firebase-config.js";
import {
  initializeApp, deleteApp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, addDoc, getDoc, getDocs,
  query, where, orderBy, limit, updateDoc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
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

const STOCK_WINDOW_DAYS = 365; // khoảng thời gian dùng để tính tồn kho / lịch sử gần đây
const ITEM_SUGGESTIONS = ["Gà", "Nấm", "Gạo nếp", "Đậu xanh", "Dầu ăn", "Hành phi", "Gia vị", "Nước tương", "Túi/hộp gói"];

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
      await Promise.all([loadStaffDirectory(), loadLocationsDirectory(), loadSettings()]);
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

/* ===================== ROUTER ===================== */
const ADMIN_ONLY = ["bao-cao", "quan-ly"];
const TITLES = {
  "trang-chu": "Trang chủ", "cham-cong": "Chấm công", "kho": "Kho & Chuyển hàng",
  "bao-cao": "Báo cáo", "quan-ly": "Quản lý",
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
  statsEl.innerHTML = `<div class="hero-stat"><span class="num">…</span><span class="label">Đang tải</span></div>`;

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

/* ===================== CHẤM CÔNG ===================== */
let entryCacheForUser = [];

async function renderChamCong() {
  mount("cham-cong");
  editingEntryId = null;

  if (!isAdmin() && !profile.locationId) {
    viewRoot.innerHTML = emptyState("Bạn chưa được gán điểm bán nên chưa thể chấm công. Liên hệ chủ quán.");
    return;
  }

  const locBadge = $('[data-bind="entry-location"]');
  if (locBadge) locBadge.textContent = locationName(profile.locationId);

  const dateEl = $("#entry-date");
  dateEl.value = todayISO();
  $("#entry-luong").value = locationsDirectory[profile.locationId]?.luongMacDinh ?? settings.luongMacDinh ?? "";

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
    const payload = {
      uid: currentUser.uid,
      name: profile.name,
      locationId: profile.locationId,
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
    try {
      if (editingEntryId) {
        await updateDoc(doc(db, "entries", editingEntryId), payload);
        toast("Đã cập nhật phiếu chấm công");
      } else {
        payload.createdAt = serverTimestamp();
        await addDoc(collection(db, "entries"), payload);
        toast("Đã lưu phiếu chấm công");
      }
      resetEntryForm();
      await loadAndRenderEntryList();
    } catch (err) {
      console.error(err);
      toast("Lỗi khi lưu phiếu. Thử lại nhé.");
    }
  });

  $("#entry-filter").addEventListener("change", renderEntryListFiltered);

  await loadAndRenderEntryList();
}

function resetEntryForm() {
  editingEntryId = null;
  const f = $("#form-entry");
  if (!f) return;
  f.reset();
  $("#entry-date").value = todayISO();
  $("#entry-luong").value = locationsDirectory[profile.locationId]?.luongMacDinh ?? settings.luongMacDinh ?? "";
  $("#btn-entry-cancel").hidden = true;
  $$("input", $("#entry-work-fields")).forEach((i) => (i.disabled = false));
}

async function loadAndRenderEntryList() {
  const list = $('[data-bind="entry-list"]');
  list.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  try {
    entryCacheForUser = await fetchEntriesByUid(currentUser.uid);
    renderEntryListFiltered();
  } catch (err) {
    console.error(err);
    list.innerHTML = emptyState("Không tải được lịch sử");
  }
}

function renderEntryListFiltered() {
  const days = parseInt($("#entry-filter").value, 10);
  const cutoff = addDays(todayISO(), -days);
  const rows = entryCacheForUser.filter((r) => r.date >= cutoff);
  $('[data-bind="entry-list"]').innerHTML = renderEntryCards(rows, false, true) || emptyState("Không có dữ liệu trong khoảng này");
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
        ${r.dep ? `<span>Xôi ế/dẹp: <b>${fmtNum(r.dep)}</b></span>` : ""}
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

  const locEditBtn = e.target.closest("[data-loc-edit]");
  const locToggleBtn = e.target.closest("[data-loc-toggle]");
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

function itemDatalistHtml() {
  return `<datalist id="item-suggestions">${ITEM_SUGGESTIONS.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("")}</datalist>`;
}

async function renderKho() {
  mount("kho");
  editingIngId = null;
  editingTransferId = null;
  viewRoot.insertAdjacentHTML("beforeend", itemDatalistHtml());

  const kitchenMode = isKitchenContext();
  const readonlyEl = $('[data-bind="kho-readonly"]');
  const manageEl = $('[data-bind="kho-manage"]');

  if (!kitchenMode) {
    // Điểm bán: chỉ xem hàng đã nhận từ bếp, không nhập/xuất được
    manageEl.hidden = true;
    readonlyEl.hidden = false;
    if (!profile.locationId) {
      readonlyEl.innerHTML = emptyState("Bạn chưa được gán điểm bán.");
      return;
    }
    readonlyEl.innerHTML = `<p class="empty-state">Đang tải…</p>`;
    try {
      const from = addDays(todayISO(), -STOCK_WINDOW_DAYS);
      const all = await fetchTransfersByRange(from, todayISO());
      const mine = all.filter((r) => r.toLocationId === profile.locationId).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 40);
      readonlyEl.innerHTML = `<h3 class="section-heading">Đã nhận từ bếp trung tâm</h3>
        <div class="stack">${renderTransferCards(mine, false)}</div>` .replace('<div class="stack"></div>', emptyState("Chưa nhận hàng nào từ bếp trung tâm"));
    } catch (err) {
      console.error(err);
      readonlyEl.innerHTML = emptyState("Không tải được dữ liệu");
    }
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
  const trfToSel = $("#trf-to");
  const pLocs = pointLocations();
  trfToSel.innerHTML = pLocs.length
    ? pLocs.map(([id, l]) => `<option value="${id}">${escapeHtml(l.name)}</option>`).join("")
    : `<option value="">(chưa có điểm bán)</option>`;

  $("#btn-ing-cancel").addEventListener("click", () => resetIngForm());
  $("#btn-trf-cancel").addEventListener("click", () => resetTrfForm());

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
    try {
      if (editingIngId) {
        await updateDoc(doc(db, "ingredients", editingIngId), payload);
        toast("Đã cập nhật");
      } else {
        payload.createdAt = serverTimestamp();
        await addDoc(collection(db, "ingredients"), payload);
        toast("Đã lưu nguyên liệu");
      }
      resetIngForm();
      await loadAndRenderKho(opKitchenId);
    } catch (err) { console.error(err); toast("Lỗi khi lưu"); }
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
    try {
      if (editingTransferId) {
        await updateDoc(doc(db, "transfers", editingTransferId), payload);
        toast("Đã cập nhật");
      } else {
        payload.createdAt = serverTimestamp();
        await addDoc(collection(db, "transfers"), payload);
        toast("Đã ghi nhận chuyển hàng");
      }
      resetTrfForm();
      await loadAndRenderKho(opKitchenId);
    } catch (err) { console.error(err); toast("Lỗi khi lưu"); }
  });

  await loadAndRenderKho(opKitchenId);
}

function resetIngForm() {
  editingIngId = null;
  const f = $("#form-ing");
  if (!f) return;
  f.reset();
  $("#ing-date").value = todayISO();
  $("#btn-ing-cancel").hidden = true;
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

    if (ingListEl) ingListEl.innerHTML = renderIngCards(ingCacheGlobal.slice(0, 30)) || emptyState(`Chưa có nguyên liệu nhập trong ${STOCK_WINDOW_DAYS} ngày qua`);
    if (trfListEl) trfListEl.innerHTML = renderTransferCards(transferCacheGlobal.slice(0, 30), true) || emptyState("Chưa chuyển hàng cho điểm bán nào");

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
      stockEl.innerHTML = rows.length ? `
        <table class="data-table">
          <thead><tr><th>Nguyên liệu</th><th>Đơn vị</th><th>Tồn hiện tại</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td>${escapeHtml(r.itemName)}</td><td>${escapeHtml(r.unit)}</td><td><b>${fmtNum(r.ton)}</b></td></tr>`).join("")}</tbody>
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

  await loadReport();
}

let reportEntriesCache = [];
let reportIngCache = [];

async function loadReport() {
  const from = $("#report-from").value, to = $("#report-to").value;
  const locFilter = $("#report-location").value;
  const sumEl = $('[data-bind="report-summary"]');
  sumEl.innerHTML = `<div class="stat-card"><div class="label">Đang tải…</div></div>`;
  try {
    [reportEntriesCache, reportIngCache] = await Promise.all([
      fetchEntriesByRange(from, to),
      fetchIngredientsByRange(from, to),
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
  const loiNhuan = doanhThu - chiPhiNL - luongThuong;

  sumEl.innerHTML = `
    <div class="stat-card gold"><div class="label">Doanh thu ước tính</div><div class="value">${fmt(doanhThu)}</div></div>
    <div class="stat-card"><div class="label">Số lượng bán</div><div class="value">${fmtNum(tongSoLuong)}</div></div>
    <div class="stat-card accent"><div class="label">Chi phí nguyên liệu${selectedIsPoint ? " (—)" : ""}</div><div class="value">${fmt(chiPhiNL)}</div></div>
    <div class="stat-card accent"><div class="label">Lương + thưởng</div><div class="value">${fmt(luongThuong)}</div></div>
    <div class="stat-card"><div class="label">Lợi nhuận ước tính</div><div class="value">${fmt(loiNhuan)}</div></div>
  `;
  if (selectedIsPoint) {
    sumEl.insertAdjacentHTML("beforeend", `<p class="hint-text" style="grid-column:1/-1;">Chi phí nguyên liệu phát sinh chung ở bếp trung tâm nên không chia theo từng điểm bán — xem ở lựa chọn "Tất cả điểm" hoặc điểm bếp.</p>`);
  }

  renderByLocationTable(allWorked, reportIngCache, locFilter);
  renderByStaffTable(worked, !locFilter);
  renderDailyBarChart(worked, from, to);
  await renderSettlements(worked);
}

function renderByLocationTable(allWorked, allIng, locFilter) {
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
  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Điểm bán</th><th>Số lượng</th><th>Doanh thu</th><th>Lương+thưởng</th><th>Lãi (chưa trừ NL)</th></tr></thead>
      <tbody>
        ${rows.map((g) => `<tr><td>${escapeHtml(g.name)}</td><td>${fmtNum(g.soLuong)}</td><td>${fmt(g.doanhThu)}</td><td>${fmt(g.luongThuong)}</td><td><b>${fmt(g.doanhThu - g.luongThuong)}</b></td></tr>`).join("")}
      </tbody>
    </table>
    <p class="hint-text">Chi phí nguyên liệu toàn hệ thống (dùng chung ở bếp trung tâm): <b>${fmt(chiPhiNLTong)}</b> — chưa phân bổ vào từng điểm ở bảng trên.</p>
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
  const rows = [["Ngày", "Điểm bán", "Nhân viên", "Lương", "Số lượng", "Thưởng", "Tổng", "Ship", "Xôi ế/dẹp", "Ghi chú"]];
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

  $("#form-staff").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#staff-name").value.trim();
    const email = $("#staff-email").value.trim();
    const password = $("#staff-password").value;
    const role = $("#staff-role").value;
    const staffLocationId = $("#staff-location").value;
    if (!staffLocationId) { toast("Chọn điểm bán cho nhân viên"); return; }
    const btn = e.submitter;
    btn.disabled = true;
    try {
      const secondary = initializeApp(firebaseConfig, "Secondary-" + Date.now());
      const secondaryAuth = getAuth(secondary);
      try {
        const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
        await setDoc(doc(db, "users", cred.user.uid), {
          name, role, email, locationId: staffLocationId, active: true, createdAt: serverTimestamp(),
        });
        await signOut(secondaryAuth);
      } finally {
        await deleteApp(secondary);
      }
      toast("Đã tạo tài khoản cho " + name);
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
      ${uid !== currentUser.uid ? `<div class="entry-row-actions">
        <button class="link-btn" data-toggle-active="${uid}">${u.active === false ? "Kích hoạt lại" : "Vô hiệu hoá"}</button>
      </div>` : `<div class="entry-note">Tài khoản của bạn</div>`}
    </div>
  `).join("");

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
