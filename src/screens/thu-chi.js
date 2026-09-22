/* ===================== THU & CHI ===================== */
import {
  addDoc, collection, deleteDoc, doc, serverTimestamp, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db } from "../firebase-init.js";
import { $, $$, viewRoot, mount, emptyState, toast, reportError, wireReceiptInput, receiptThumbHtml } from "../ui.js";
import { state, activeLocations, staffName, locationName } from "../state.js";
import { fetchThuChiByRange, saveOp } from "../data.js";
import { addDays, escapeHtml, fmt, formatDateVN, matchesSearch, mondayOf, todayISO } from "../calc.js";
import { THU_CHI_CATEGORIES } from "../constants.js";

let thuChiCacheGlobal = [];
let editingThuChiId = null;
let tcListLimit = 30; // "Xem thêm" — tăng dần khi bấm
let tcReceiptCtl = null; // control ảnh hoá đơn của form thu chi (gắn trong renderThuChi)

function thuChiDatalistHtml() {
  return `<datalist id="thuchi-suggestions">${THU_CHI_CATEGORIES.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("")}</datalist>`;
}

function tcLocationLabel(id) { return id ? locationName(id) : "Chung (toàn quán)"; }

export async function renderThuChi() {
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
      uid: state.currentUser.uid,
      name: state.profile.name,
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

// Event delegation cho sửa/xoá giao dịch thu chi trong view-root (view-root
// tồn tại xuyên suốt các lần render — đăng ký 1 lần duy nhất ở đây, không
// đăng ký lại mỗi lần renderThuChi()).
viewRoot.addEventListener("click", async (e) => {
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
    } catch (err) { reportError(err, "Không xoá được"); }
  }
});
