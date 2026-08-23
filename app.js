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
let profile = null; // { name, role, email }
let staffDirectory = {}; // uid -> {name, role}
let settings = { giaBan: 15000, luongMacDinh: 60000 };
let editingEntryId = null;
let editingIngId = null;

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
      await loadStaffDirectory();
      await loadSettings();
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
  $("#user-chip").textContent = `${profile.name} · ${profile.role === "admin" ? "Chủ quán" : "Nhân viên"}`;
  $$(".nav-item[data-admin-only]").forEach((btn) => { btn.hidden = profile.role !== "admin"; });
  if (!location.hash || (profile.role !== "admin" && ["#/bao-cao", "#/nhan-vien"].includes(location.hash))) {
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

async function fetchIngredientsRecent(n = 60) {
  const q = query(collection(db, "ingredients"), orderBy("date", "desc"), limit(n));
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

/* ===================== ROUTER ===================== */
const ADMIN_ONLY = ["bao-cao", "nhan-vien"];
const TITLES = {
  "trang-chu": "Trang chủ", "cham-cong": "Chấm công", "nguyen-lieu": "Nguyên liệu",
  "bao-cao": "Báo cáo", "nhan-vien": "Nhân viên",
};

window.addEventListener("hashchange", router);
$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => { location.hash = "#/" + btn.dataset.view; });
});

function router() {
  if (!profile) return;
  let view = (location.hash || "#/trang-chu").replace("#/", "");
  if (!TITLES[view]) view = "trang-chu";
  if (ADMIN_ONLY.includes(view) && profile.role !== "admin") {
    toast("Bạn không có quyền truy cập mục này.");
    view = "trang-chu";
    location.hash = "#/trang-chu";
  }
  $("#view-title").textContent = TITLES[view];
  $$(".nav-item").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === view));
  window.scrollTo(0, 0);

  if (view === "trang-chu") renderTrangChu();
  else if (view === "cham-cong") renderChamCong();
  else if (view === "nguyen-lieu") renderNguyenLieu();
  else if (view === "bao-cao") renderBaoCao();
  else if (view === "nhan-vien") renderNhanVien();
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
  statsEl.innerHTML = `<div class="hero-stat"><span class="num">…</span><span class="label">Đang tải</span></div>`;

  actionsEl.innerHTML = `
    <button class="quick-action" data-go="cham-cong">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
      Chấm công hôm nay
    </button>
    <button class="quick-action" data-go="nguyen-lieu">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3h14l-1 6a6 6 0 0 1-12 0L5 3Z"/><path d="M9 21h6M12 15v6"/></svg>
      Nhập nguyên liệu
    </button>
    ${profile.role === "admin" ? `<button class="quick-action" data-go="bao-cao">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>
      Xem báo cáo
    </button>` : ""}
  `;
  $$("[data-go]", actionsEl).forEach((b) => b.addEventListener("click", () => { location.hash = "#/" + b.dataset.go; }));

  try {
    if (profile.role === "admin") {
      const today = todayISO();
      const rows = await fetchEntriesByRange(today, today);
      const totalDoanhThu = rows.filter((r) => !r.offDay).reduce((s, r) => s + (r.soLuong || 0) * (settings.giaBan || 0), 0);
      const soNVLam = new Set(rows.filter((r) => !r.offDay).map((r) => r.uid)).size;
      statsEl.innerHTML = `
        <div class="hero-stat"><span class="num">${fmt(totalDoanhThu)}</span><span class="label">Doanh thu ước tính hôm nay</span></div>
        <div class="hero-stat"><span class="num">${soNVLam}</span><span class="label">Nhân viên đã chấm công</span></div>
      `;
      recentEl.innerHTML = renderEntryCards(rows.slice(0, 6), true, false) || emptyState("Chưa có phiếu chấm công hôm nay");
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
    }
  } catch (err) {
    console.error(err);
    statsEl.innerHTML = `<div class="hero-stat"><span class="num">—</span><span class="label">Lỗi tải dữ liệu</span></div>`;
  }
}

function emptyState(msg) {
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 3h14l-1 6a6 6 0 0 1-12 0L5 3Z"/><path d="M9 21h6M12 15v6"/></svg>
    <div>${msg}</div>
  </div>`;
}

/* ===================== CHẤM CÔNG ===================== */
let entryCacheForUser = [];

async function renderChamCong() {
  mount("cham-cong");
  editingEntryId = null;
  const dateEl = $("#entry-date");
  dateEl.value = todayISO();
  $("#entry-luong").value = settings.luongMacDinh || "";

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
  $("#entry-luong").value = settings.luongMacDinh || "";
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

function renderEntryCards(rows, showName, showActions = false) {
  if (!rows.length) return "";
  return rows.map((r) => `
    <div class="entry-card" data-id="${r.id}">
      <div class="entry-card-top">
        <span class="entry-date">${formatDateVN(r.date)}${showName ? " · " + (r.name || staffName(r.uid)) : ""}</span>
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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Event delegation for entry list edit/delete (view-root persists across renders)
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
    $("#ing-ga").value = row.gaKg || "";
    $("#ing-nam").value = row.namGr || "";
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
      await loadAndRenderIngList();
    } catch (err) { console.error(err); toast("Không xoá được"); }
  }
});

/* ===================== NGUYÊN LIỆU ===================== */
let ingCacheGlobal = [];

async function renderNguyenLieu() {
  mount("nguyen-lieu");
  editingIngId = null;
  $("#ing-date").value = todayISO();

  $("#btn-ing-cancel").addEventListener("click", () => resetIngForm());

  $("#form-ing").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      uid: currentUser.uid,
      date: $("#ing-date").value,
      gaKg: parseFloat($("#ing-ga").value) || 0,
      namGr: parseFloat($("#ing-nam").value) || 0,
      tien: parseFloat($("#ing-tien").value) || 0,
      ghiChu: $("#ing-ghichu").value.trim(),
      updatedAt: serverTimestamp(),
    };
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
      await loadAndRenderIngList();
    } catch (err) { console.error(err); toast("Lỗi khi lưu"); }
  });

  await loadAndRenderIngList();
}

function resetIngForm() {
  editingIngId = null;
  const f = $("#form-ing");
  if (!f) return;
  f.reset();
  $("#ing-date").value = todayISO();
  $("#btn-ing-cancel").hidden = true;
}

async function loadAndRenderIngList() {
  const list = $('[data-bind="ing-list"]');
  list.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  try {
    ingCacheGlobal = await fetchIngredientsRecent(60);
    list.innerHTML = renderIngCards(ingCacheGlobal) || emptyState("Chưa có dữ liệu nguyên liệu");
  } catch (err) { console.error(err); list.innerHTML = emptyState("Không tải được"); }
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
        ${r.gaKg ? `<span>Gà: <b>${fmtNum(r.gaKg)} kg</b></span>` : ""}
        ${r.namGr ? `<span>Nấm: <b>${fmtNum(r.namGr)} gr</b></span>` : ""}
      </div>
      ${r.ghiChu ? `<div class="entry-note">${escapeHtml(r.ghiChu)}</div>` : ""}
      <div class="entry-row-actions">
        <button class="link-btn" data-ing-edit="${r.id}">Sửa</button>
        <button class="link-btn danger" data-ing-del="${r.id}">Xoá</button>
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

  const worked = reportEntriesCache.filter((r) => !r.offDay);
  const tongSoLuong = worked.reduce((s, r) => s + (r.soLuong || 0), 0);
  const doanhThu = worked.reduce((s, r) => s + (r.soLuong || 0) * (settings.giaBan || 0), 0);
  const chiPhiNL = reportIngCache.reduce((s, r) => s + (r.tien || 0), 0);
  const luongThuong = worked.reduce((s, r) => s + (r.tong || 0), 0);
  const loiNhuan = doanhThu - chiPhiNL - luongThuong;

  sumEl.innerHTML = `
    <div class="stat-card gold"><div class="label">Doanh thu ước tính</div><div class="value">${fmt(doanhThu)}</div></div>
    <div class="stat-card"><div class="label">Số lượng bán</div><div class="value">${fmtNum(tongSoLuong)}</div></div>
    <div class="stat-card accent"><div class="label">Chi phí nguyên liệu</div><div class="value">${fmt(chiPhiNL)}</div></div>
    <div class="stat-card accent"><div class="label">Lương + thưởng</div><div class="value">${fmt(luongThuong)}</div></div>
    <div class="stat-card"><div class="label">Lợi nhuận ước tính</div><div class="value">${fmt(loiNhuan)}</div></div>
  `;

  renderByStaffTable(worked);
  renderDailyBarChart(worked, from, to);
  await renderSettlements(reportEntriesCache);
}

function renderByStaffTable(worked) {
  const groups = {};
  worked.forEach((r) => {
    groups[r.uid] = groups[r.uid] || { name: r.name || staffName(r.uid), soNgay: 0, soLuong: 0, luong: 0, thuong: 0, tong: 0 };
    const g = groups[r.uid];
    g.soNgay++; g.soLuong += r.soLuong || 0; g.luong += r.luong || 0; g.thuong += r.thuong || 0; g.tong += r.tong || 0;
  });
  const rows = Object.values(groups).sort((a, b) => b.tong - a.tong);
  const el = $('[data-bind="report-by-staff"]');
  if (!rows.length) { el.innerHTML = emptyState("Chưa có phiếu chấm công trong khoảng này"); return; }
  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Nhân viên</th><th>Ngày làm</th><th>Số lượng</th><th>Lương</th><th>Thưởng</th><th>Tổng nhận</th></tr></thead>
      <tbody>
        ${rows.map((g) => `<tr><td>${escapeHtml(g.name)}</td><td>${g.soNgay}</td><td>${fmtNum(g.soLuong)}</td><td>${fmt(g.luong)}</td><td>${fmt(g.thuong)}</td><td><b>${fmt(g.tong)}</b></td></tr>`).join("")}
      </tbody>
    </table>
  `;
}

function renderDailyBarChart(worked, from, to) {
  const byDay = {};
  worked.forEach((r) => { byDay[r.date] = (byDay[r.date] || 0) + (r.soLuong || 0) * (settings.giaBan || 0); });
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
  entries.filter((r) => !r.offDay).forEach((r) => {
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
  const rows = [["Ngày", "Nhân viên", "Lương", "Số lượng", "Thưởng", "Tổng", "Ship", "Xôi ế/dẹp", "Ghi chú"]];
  reportEntriesCache.forEach((r) => {
    rows.push([r.date, r.name || staffName(r.uid), r.offDay ? "Nghỉ" : r.luong, r.offDay ? "" : r.soLuong,
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

/* ===================== NHÂN VIÊN ===================== */
async function renderNhanVien() {
  mount("nhan-vien");

  $("#form-staff").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#staff-name").value.trim();
    const email = $("#staff-email").value.trim();
    const password = $("#staff-password").value;
    const role = $("#staff-role").value;
    const btn = e.submitter;
    btn.disabled = true;
    try {
      const secondary = initializeApp(firebaseConfig, "Secondary-" + Date.now());
      const secondaryAuth = getAuth(secondary);
      try {
        const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
        await setDoc(doc(db, "users", cred.user.uid), {
          name, role, email, active: true, createdAt: serverTimestamp(),
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

  $("#form-settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    const giaBan = parseFloat($("#setting-giaban").value) || 0;
    const luongMacDinh = parseFloat($("#setting-luong").value) || 0;
    try {
      await setDoc(doc(db, "settings", "general"), { giaBan, luongMacDinh, updatedAt: serverTimestamp() }, { merge: true });
      settings.giaBan = giaBan; settings.luongMacDinh = luongMacDinh;
      toast("Đã lưu cài đặt");
    } catch (err) { console.error(err); toast("Không lưu được cài đặt"); }
  });
  $("#setting-giaban").value = settings.giaBan || "";
  $("#setting-luong").value = settings.luongMacDinh || "";

  await loadStaffDirectory();
  renderStaffList();
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
      <div class="entry-meta"><span>${escapeHtml(u.email || "")}</span></div>
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
