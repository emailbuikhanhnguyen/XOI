/* ===================== KHO & CHUYỂN HÀNG ===================== */
import {
  addDoc, collection, deleteDoc, doc, serverTimestamp, setDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db } from "../firebase-init.js";
import { $, $$, viewRoot, mount, emptyState, toast, reportError, wireReceiptInput, receiptThumbHtml } from "../ui.js";
import {
  state, isAdmin, isKitchenContext, kitchenLocations, locationName, operatingKitchenId, pointLocations,
} from "../state.js";
import { fetchEntriesByRange, fetchIngredientsByRange, fetchOrdersByRange, fetchTransfersByRange, logChange, saveOp } from "../data.js";
import { addDays, escapeHtml, fmt, fmtNum, formatDateVN, matchesSearch, normalizeUnit, slugifyItemName, suggestedQtyForWeekday, todayISO } from "../calc.js";
import { DATE_ENTRY_PAST_DAYS, EXPIRY_WARN_DAYS, FORECAST_LOOKBACK_DAYS, ITEM_SUGGESTIONS, STOCK_WINDOW_DAYS, UNIT_SUGGESTIONS } from "../constants.js";

let ingCacheGlobal = [];
let transferCacheGlobal = [];
let ordersCacheGlobal = [];
let editingIngId = null;
let editingTransferId = null;
let ingListLimit = 30, trfListLimit = 30; // "Xem thêm" — tăng dần khi bấm
let ingReceiptCtl = null; // control ảnh hoá đơn của form nhập nguyên liệu (gắn trong renderKho)
// Nguyên liệu người dùng tự thêm vào danh sách Kiểm kê kho (chưa từng có
// lịch sử nhập/chuyển nào ở bếp này) — chỉ tồn tại phía client cho tới khi
// bấm Lưu, lúc đó mới ghi thành 1 dòng "nhập nguyên liệu" điều chỉnh thật sự.
let stocktakeExtraItems = [];
// Bộ lọc "Tất cả / Sản xuất / Điểm bán" dùng chung cho bảng Tồn kho hiện tại
// và bảng Kiểm kê kho (xem passesLoaiFilter()).
let khoLoaiFilter = "tatca";

function itemDatalistHtml() {
  return `<datalist id="item-suggestions">${ITEM_SUGGESTIONS.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("")}</datalist>
  <datalist id="unit-suggestions">${UNIT_SUGGESTIONS.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("")}</datalist>`;
}

// Tên các nguyên liệu chủ quán đã phân loại "dùng cho điểm bán" (itemCatalog.diemBan
// === true) — dùng để giới hạn những gì nhân viên điểm bán thấy/gõ khi đặt hàng,
// không lộ ra các nguyên liệu chỉ dùng cho sản xuất ở bếp.
function posItemNames() {
  return Object.values(state.itemCatalog)
    .filter((c) => c.diemBan === true)
    .map((c) => c.itemName)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "vi"));
}

// Datalist gợi ý riêng cho ô "Nguyên liệu / mặt hàng cần" ở form đặt hàng của điểm
// bán: chỉ gợi ý nguyên liệu đã được phân loại "dùng cho điểm bán". Nếu chủ quán
// chưa phân loại nguyên liệu nào (mới dùng tính năng lần đầu), tạm rơi về danh sách
// gợi ý chung để form vẫn dùng được, tránh ô gợi ý trống trơn.
function orderItemDatalistHtml() {
  const names = posItemNames();
  const list = names.length ? names : ITEM_SUGGESTIONS;
  return `<datalist id="order-item-suggestions">${list.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("")}</datalist>`;
}

// Danh sách (dạng chip, bấm để điền nhanh vào ô "Nguyên liệu / mặt hàng cần") các
// nguyên liệu đã được phân loại "dùng cho điểm bán" — cho nhân viên điểm bán biết
// chủ quán đã chuẩn bị/nhập kho những mặt hàng nào cho điểm bán, mà không lộ ra
// nguyên liệu/tồn kho tổng của bếp (chỉ hiện tên, không hiện số lượng tồn).
function renderPosItemList() {
  const el = $('[data-bind="pos-item-list"]');
  if (!el) return;
  const names = posItemNames();
  if (!names.length) {
    el.innerHTML = emptyState("Chủ quán chưa phân loại nguyên liệu nào cho điểm bán (ở mục Kiểm kê kho bên bếp) — bạn vẫn có thể tự gõ tên nguyên liệu cần ở form bên dưới.");
    return;
  }
  el.innerHTML = `<div class="chip-row">${names.map((n) => `<button type="button" class="chip" data-pos-item="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join("")}</div>`;
  $$("[data-pos-item]", el).forEach((btn) => {
    btn.addEventListener("click", () => {
      $("#order-item").value = btn.dataset.posItem;
      $("#order-item").focus();
    });
  });
}

// Nguyên liệu này có thuộc nhóm đang lọc không? Chưa từng phân loại → mặc
// định coi là "Sản xuất" (giữ đúng hành vi cũ, không mất khỏi màn hình mặc
// định) và KHÔNG thuộc "Điểm bán" (phải tự đánh dấu). 1 nguyên liệu có thể
// thuộc cả 2 nhóm cùng lúc. Nguyên liệu vừa tự thêm vào Kiểm kê kho (chưa kịp
// lưu phân loại) luôn hiện, khỏi bị "biến mất" ngay sau khi thêm.
function passesLoaiFilter(name) {
  if (khoLoaiFilter === "tatca") return true;
  if (stocktakeExtraItems.some((r) => r.itemName === name)) return true;
  const cat = state.itemCatalog[name];
  if (khoLoaiFilter === "sanxuat") return cat?.sanXuat !== false;
  if (khoLoaiFilter === "diemban") return cat?.diemBan === true;
  return true;
}

export async function renderKho() {
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
    if (!state.profile.locationId) {
      readonlyEl.innerHTML = emptyState("Bạn chưa được gán điểm bán.");
      return;
    }

    viewRoot.insertAdjacentHTML("beforeend", orderItemDatalistHtml());
    renderPosItemList();

    $("#order-date").value = todayISO();
    $("#form-order").addEventListener("submit", async (e) => {
      e.preventDefault();
      const itemName = $("#order-item").value.trim();
      const qty = parseFloat($("#order-qty").value) || 0;
      if (!itemName) { toast("Nhập tên nguyên liệu / mặt hàng cần"); return; }
      if (qty <= 0) { toast("Nhập số lượng lớn hơn 0"); return; }
      const payload = {
        uid: state.currentUser.uid,
        locationId: state.profile.locationId,
        date: $("#order-date").value,
        itemName,
        unit: normalizeUnit($("#order-unit").value),
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

  stocktakeExtraItems = [];
  khoLoaiFilter = "tatca";
  const khoLoaiFilterSel = $("#kho-loai-filter");
  if (khoLoaiFilterSel) {
    khoLoaiFilterSel.value = "tatca";
    khoLoaiFilterSel.addEventListener("change", (e) => {
      khoLoaiFilter = e.target.value;
      renderStockTableUI();
      renderStockTakeTable(opKitchenId);
    });
  }
  const stocktakeSection = $('[data-bind="stocktake-section"]');
  const stocktakeToggle = $('[data-bind="stocktake-toggle"]');
  if (stocktakeSection) stocktakeSection.hidden = true;
  if (stocktakeToggle) {
    stocktakeToggle.textContent = "Kiểm kê kho";
    stocktakeToggle.addEventListener("click", () => {
      const show = stocktakeSection.hidden;
      stocktakeSection.hidden = !show;
      stocktakeToggle.textContent = show ? "Ẩn kiểm kê kho" : "Kiểm kê kho";
    });
  }
  $("#btn-stocktake-add")?.addEventListener("click", () => {
    const name = $("#stocktake-new-item").value.trim();
    const unit = normalizeUnit($("#stocktake-new-unit").value);
    if (!name) { toast("Nhập tên nguyên liệu cần thêm"); return; }
    if (!stocktakeExtraItems.some((r) => r.itemName === name)) stocktakeExtraItems.push({ itemName: name, unit });
    $("#stocktake-new-item").value = "";
    renderStockTakeTable(opKitchenId);
  });

  // Giới hạn khoảng ngày cho phép chọn — KHÔNG áp dụng cho order-date (đặt
  // hàng luôn hướng tới tương lai gần, không phải ghi nhận việc đã xảy ra).
  const dateMin = addDays(todayISO(), -DATE_ENTRY_PAST_DAYS);
  $("#ing-date").min = dateMin;
  $("#ing-date").max = todayISO();
  $("#ing-date").value = todayISO();
  $("#trf-date").min = dateMin;
  $("#trf-date").max = todayISO();
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
    const ingDateEl = $("#ing-date");
    if (ingDateEl.value < ingDateEl.min || ingDateEl.value > ingDateEl.max) {
      toast(`Chỉ được chọn ngày từ ${formatDateVN(ingDateEl.min)} đến ${formatDateVN(ingDateEl.max)}.`);
      return;
    }
    const payload = {
      uid: state.currentUser.uid,
      locationId: opKitchenId,
      date: $("#ing-date").value,
      itemName: $("#ing-item").value.trim(),
      unit: normalizeUnit($("#ing-unit").value),
      qty: parseFloat($("#ing-qty").value) || 0,
      tien: parseFloat($("#ing-tien").value) || 0,
      hanSuDung: $("#ing-hansudung").value || "",
      nhaCungCap: $("#ing-ncc").value.trim(),
      // Chỉ thật sự "còn nợ" khi có ghi tên nhà cung cấp — bỏ trống tên NCC
      // thì coi như mua lẻ/chợ, không theo dõi công nợ dù có tick nhầm.
      congNo: !!($("#ing-ncc").value.trim() && $("#ing-congno").checked),
      ghiChu: $("#ing-ghichu").value.trim(),
      updatedAt: serverTimestamp(),
    };
    if (!payload.itemName) { toast("Nhập tên nguyên liệu"); return; }
    if (!(payload.qty > 0)) { toast("Nhập số lượng lớn hơn 0"); return; }
    payload.anhHoaDon = ingReceiptCtl ? ingReceiptCtl.get() : "";
    const wasEditing = !!editingIngId;
    if (!wasEditing) payload.createdAt = serverTimestamp();
    const beforeIngRow = wasEditing ? ingCacheGlobal.find((r) => r.id === editingIngId) : null;
    const ingBtn = e.submitter;
    if (ingBtn) ingBtn.disabled = true;
    try {
      await saveOp(
        () => (wasEditing ? updateDoc(doc(db, "ingredients", editingIngId), payload) : addDoc(collection(db, "ingredients"), payload)),
        async (confirmed) => {
          if (wasEditing) logChange("ingredients", editingIngId, "update", beforeIngRow, payload);
          toast(wasEditing ? "Đã cập nhật" : (confirmed ? "Đã lưu nguyên liệu" : "Đã lưu (chưa có mạng — sẽ tự đồng bộ)"));
          resetIngForm();
          await loadAndRenderKho(opKitchenId);
        }
      );
    } finally {
      if (ingBtn) ingBtn.disabled = false;
    }
  });

  $("#form-trf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trfDateEl = $("#trf-date");
    if (trfDateEl.value < trfDateEl.min || trfDateEl.value > trfDateEl.max) {
      toast(`Chỉ được chọn ngày từ ${formatDateVN(trfDateEl.min)} đến ${formatDateVN(trfDateEl.max)}.`);
      return;
    }
    const toId = $("#trf-to").value;
    if (!toId) { toast("Chọn điểm bán nhận hàng"); return; }
    const payload = {
      uid: state.currentUser.uid,
      fromLocationId: opKitchenId,
      toLocationId: toId,
      date: $("#trf-date").value,
      itemName: $("#trf-item").value.trim(),
      unit: normalizeUnit($("#trf-unit").value),
      qty: parseFloat($("#trf-qty").value) || 0,
      ghiChu: $("#trf-ghichu").value.trim(),
      updatedAt: serverTimestamp(),
    };
    if (!payload.itemName) { toast("Nhập tên hàng chuyển"); return; }
    if (!(payload.qty > 0)) { toast("Nhập số lượng lớn hơn 0"); return; }
    const wasEditing = !!editingTransferId;
    if (!wasEditing) payload.createdAt = serverTimestamp();
    const beforeTrfRow = wasEditing ? transferCacheGlobal.find((r) => r.id === editingTransferId) : null;
    const trfBtn = e.submitter;
    if (trfBtn) trfBtn.disabled = true;
    try {
      await saveOp(
        () => (wasEditing ? updateDoc(doc(db, "transfers", editingTransferId), payload) : addDoc(collection(db, "transfers"), payload)),
        async (confirmed) => {
          if (wasEditing) logChange("transfers", editingTransferId, "update", beforeTrfRow, payload);
          toast(wasEditing ? "Đã cập nhật" : (confirmed ? "Đã ghi nhận chuyển hàng" : "Đã ghi nhận (chưa có mạng — sẽ tự đồng bộ)"));
          resetTrfForm();
          await loadAndRenderKho(opKitchenId);
        }
      );
    } finally {
      if (trfBtn) trfBtn.disabled = false;
    }
  });

  await Promise.all([loadAndRenderKho(opKitchenId), loadAndRenderOrderRequests(), loadAndRenderPrepSuggestion()]);
}

function resetIngForm() {
  editingIngId = null;
  const f = $("#form-ing");
  if (!f) return;
  f.reset();
  // form.reset() không đụng tới min/max — đặt lại min chuẩn phòng khi lần
  // sửa trước đã nới min để hiện được 1 dòng cũ hơn (xem nhánh ingEditBtn).
  $("#ing-date").min = addDays(todayISO(), -DATE_ENTRY_PAST_DAYS);
  $("#ing-date").value = todayISO();
  $("#btn-ing-cancel").hidden = true;
  ingReceiptCtl?.set("");
}

function resetTrfForm() {
  editingTransferId = null;
  const f = $("#form-trf");
  if (!f) return;
  f.reset();
  $("#trf-date").min = addDays(todayISO(), -DATE_ENTRY_PAST_DAYS);
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

    renderStockTableUI();
    renderStockTakeTable(opKitchenId);
    renderStocktakeHistory();
    renderSupplierDebtTable();
  } catch (err) {
    console.error(err);
    if (ingListEl) ingListEl.innerHTML = emptyState("Không tải được");
    if (trfListEl) trfListEl.innerHTML = emptyState("Không tải được");
    if (stockEl) stockEl.innerHTML = emptyState("Không tải được");
  }
}

// Hạn dùng GẦN NHẤT còn được ghi nhận cho từng nguyên liệu, từ các lần nhập
// kho có điền "Hạn sử dụng" (tuỳ chọn). Ước tính đơn giản, KHÔNG theo dõi
// từng lô/FIFO (app không biết chính xác lô nào còn tồn) — chỉ lấy hạn gần
// nhất trong lịch sử nhập gần đây để NHẮC NHỞ, không phải số liệu chính xác
// tuyệt đối cho đúng phần nguyên liệu còn lại.
function computeNearestExpiryMap() {
  const map = {};
  ingCacheGlobal.forEach((r) => {
    if (!r.hanSuDung) return;
    if (!map[r.itemName] || r.hanSuDung < map[r.itemName]) map[r.itemName] = r.hanSuDung;
  });
  return map;
}

// Bảng "Tồn kho hiện tại" — tách riêng khỏi loadAndRenderKho để đổi bộ lọc
// Sản xuất/Điểm bán không cần tải lại dữ liệu từ Firestore.
function renderStockTableUI() {
  const stockEl = $('[data-bind="stock-table"]');
  if (!stockEl) return;
  const stock = computeStockMap();
  const rows = Object.values(stock).filter((r) => passesLoaiFilter(r.itemName)).sort((a, b) => a.itemName.localeCompare(b.itemName));
  const lowRows = rows.filter((r) => {
    const th = state.itemCatalog[r.itemName]?.threshold;
    return th && r.ton < th;
  });
  const lowBannerHtml = lowRows.length ? `
    <div class="reminder-banner">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
      <span>Sắp hết ${lowRows.length} nguyên liệu: ${lowRows.map((r) => escapeHtml(r.itemName)).join(", ")}.</span>
    </div>` : "";
  // Tồn ÂM nghĩa là số đã chuyển đi nhiều hơn số đã nhập — luôn là dấu hiệu
  // nhập liệu bị sai/thiếu ở đâu đó (không phải chuyện bình thường như "sắp
  // hết"), nên cảnh báo riêng, tách biệt khỏi banner "sắp hết" ở trên.
  const negativeRows = rows.filter((r) => r.ton < 0);
  const negativeBannerHtml = negativeRows.length ? `
    <div class="reminder-banner">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
      <span>Tồn kho ÂM ở ${negativeRows.length} nguyên liệu (chuyển đi nhiều hơn đã nhập — có thể do nhập/chuyển hàng bị sai hoặc thiếu, nên kiểm tra lại lịch sử): ${negativeRows.map((r) => escapeHtml(r.itemName)).join(", ")}.</span>
    </div>` : "";
  // Sắp/đã hết hạn (chỉ cảnh báo khi còn tồn > 0 — hết hàng rồi thì hạn dùng
  // không còn ý nghĩa gì nữa).
  const expiryMap = computeNearestExpiryMap();
  const expiryCutoff = addDays(todayISO(), EXPIRY_WARN_DAYS);
  const expiringRows = rows.filter((r) => r.ton > 0 && expiryMap[r.itemName] && expiryMap[r.itemName] <= expiryCutoff);
  const expiryBannerHtml = expiringRows.length ? `
    <div class="reminder-banner gold">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
      <span>Sắp/đã hết hạn ${expiringRows.length} nguyên liệu: ${expiringRows.map((r) => `${escapeHtml(r.itemName)} (hạn ${formatDateVN(expiryMap[r.itemName])})`).join(", ")}.</span>
    </div>` : "";
  stockEl.innerHTML = rows.length ? `
    ${negativeBannerHtml}
    ${lowBannerHtml}
    ${expiryBannerHtml}
    <table class="data-table">
      <thead><tr><th>Nguyên liệu</th><th>Đơn vị</th><th>Tồn hiện tại</th></tr></thead>
      <tbody>${rows.map((r) => {
        const th = state.itemCatalog[r.itemName]?.threshold;
        const isLow = th && r.ton < th;
        const isNegative = r.ton < 0;
        const isExpiring = r.ton > 0 && expiryMap[r.itemName] && expiryMap[r.itemName] <= expiryCutoff;
        return `<tr class="${isNegative ? "stock-row-negative" : (isLow ? "stock-row-low" : "")}"><td>${escapeHtml(r.itemName)}</td><td>${escapeHtml(r.unit)}</td><td><b>${fmtNum(r.ton)}</b>${isNegative ? ` <span class="badge-warn">Tồn âm</span>` : (isLow ? ` <span class="badge-warn">Sắp hết</span>` : "")}${isExpiring ? ` <span class="badge-warn">HSD ${formatDateVN(expiryMap[r.itemName])}</span>` : ""}</td></tr>`;
      }).join("")}</tbody>
    </table>
    <p class="hint-text">Tồn kho tính trong ${STOCK_WINDOW_DAYS} ngày gần nhất (nhập − đã chuyển đi).</p>
  ` : emptyState(khoLoaiFilter === "tatca" ? "Chưa có dữ liệu tồn kho" : "Chưa có nguyên liệu nào thuộc nhóm này — đánh dấu phân loại ở mục Kiểm kê kho bên dưới");
}

// Tổng công nợ còn phải trả từng nhà cung cấp — cộng dồn "tien" của các lần
// nhập kho có ghi tên nhà cung cấp và đang đánh dấu "Còn nợ" (congNo).
// Chỉ hiện khu vực này khi thực sự có công nợ, để màn hình gọn khi không
// dùng tính năng này.
function renderSupplierDebtTable() {
  const wrap = $('[data-bind="supplier-debt-wrap"]');
  const el = $('[data-bind="supplier-debt-table"]');
  if (!wrap || !el) return;
  const debts = {};
  ingCacheGlobal.forEach((r) => {
    if (!r.congNo || !r.nhaCungCap) return;
    debts[r.nhaCungCap] = (debts[r.nhaCungCap] || 0) + (r.tien || 0);
  });
  const rows = Object.entries(debts).filter(([, tien]) => tien > 0).sort((a, b) => b[1] - a[1]);
  wrap.hidden = rows.length === 0;
  if (!rows.length) return;
  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Nhà cung cấp</th><th>Còn nợ</th></tr></thead>
      <tbody>${rows.map(([name, tien]) => `<tr><td>${escapeHtml(name)}</td><td><b>${fmt(tien)}</b></td></tr>`).join("")}</tbody>
    </table>
    <p class="hint-text">Bấm "Đánh dấu đã trả" ở dòng tương ứng trong Lịch sử nhập hàng khi đã thanh toán cho nhà cung cấp.</p>
  `;
}

// Danh sách các lần điều chỉnh từ Kiểm kê kho gần đây, cho sửa/xoá ngay tại
// đây thay vì phải tìm trong "Lịch sử nhập hàng" — tái dùng nguyên hàm
// renderIngCards() + cơ chế data-ing-edit/data-ing-del đã có sẵn.
function renderStocktakeHistory() {
  const el = $('[data-bind="stocktake-history"]');
  if (!el) return;
  const rows = ingCacheGlobal.filter((r) => (r.ghiChu || "").startsWith("Kiểm kê kho:")).slice(0, 20);
  el.innerHTML = renderIngCards(rows) || emptyState("Chưa có lần điều chỉnh kiểm kê nào");
}

// Tồn kho = tổng đã nhập − tổng đã chuyển đi, gộp theo tên nguyên liệu + đơn
// vị. Dùng chung cho cả bảng "Tồn kho hiện tại" và bảng "Kiểm kê kho".
function computeStockMap() {
  const stock = {};
  ingCacheGlobal.forEach((r) => {
    const unit = normalizeUnit(r.unit);
    const k = r.itemName + "||" + unit;
    stock[k] = stock[k] || { itemName: r.itemName, unit, ton: 0 };
    stock[k].ton += r.qty || 0;
  });
  transferCacheGlobal.forEach((r) => {
    const unit = normalizeUnit(r.unit);
    const k = r.itemName + "||" + unit;
    stock[k] = stock[k] || { itemName: r.itemName, unit, ton: 0 };
    stock[k].ton -= r.qty || 0;
  });
  return stock;
}

// Bảng "Kiểm kê kho": liệt kê mọi nguyên liệu đã biết (đã từng nhập/chuyển ở
// bếp này, đã đặt định mức, nằm trong gợi ý mặc định, hoặc người dùng tự
// thêm) kèm tồn hệ thống đang tính, để đối chiếu với số đếm thực tế. Bấm Lưu
// trên 1 dòng sẽ ghi 1 chứng từ "nhập nguyên liệu" bằng đúng phần chênh lệch
// (âm hoặc dương) — không đụng tới các nguyên liệu khác chưa Lưu.
function renderStockTakeTable(opKitchenId) {
  const el = $('[data-bind="stocktake-table"]');
  if (!el) return;
  const stock = computeStockMap();
  const stockByName = {};
  Object.values(stock).forEach((r) => { stockByName[r.itemName] = r; });

  const names = new Set([
    ...Object.values(stock).map((r) => r.itemName),
    ...Object.keys(state.itemCatalog),
    ...ITEM_SUGGESTIONS,
    ...stocktakeExtraItems.map((r) => r.itemName),
  ]);
  // Nguyên liệu đã bị "Xoá" khỏi danh sách (itemCatalog.an === true, vd gợi ý
  // mặc định không dùng tới) thì ẩn đi — TRỪ KHI nó đang có tồn/lịch sử thật
  // (stockByName[name] tồn tại), để không lỡ tay giấu mất dữ liệu thật.
  const isHidden = (name) => state.itemCatalog[name]?.an === true && !stockByName[name];
  const rows = Array.from(names).filter(Boolean).filter((n) => !isHidden(n)).filter(passesLoaiFilter).sort((a, b) => a.localeCompare(b, "vi")).map((name) => {
    const stockRow = stockByName[name];
    const extra = stocktakeExtraItems.find((r) => r.itemName === name);
    const unit = stockRow?.unit || state.itemCatalog[name]?.unit || extra?.unit || "kg";
    const computed = stockRow?.ton || 0;
    const cat = state.itemCatalog[name];
    const isCustom = !!extra;
    // Chưa có tồn/lịch sử thật (chưa từng nhập/chuyển) → cho Xoá hẳn khỏi danh
    // sách (vd nguyên liệu gợi ý mặc định nhưng quán không dùng tới, như "Đậu
    // xanh"); có lịch sử thật rồi thì không cho xoá qua đây, tránh nhầm tưởng
    // là xoá được dữ liệu tồn kho.
    const noHistory = !stockRow;
    return {
      itemName: name, unit, computed, isCustom, noHistory,
      sanXuat: cat?.sanXuat !== false,
      diemBan: cat?.diemBan === true,
    };
  });

  if (!rows.length) {
    el.innerHTML = emptyState(khoLoaiFilter === "tatca" ? "Chưa có nguyên liệu nào — thêm ở form bên dưới" : "Chưa có nguyên liệu nào thuộc nhóm này");
    return;
  }

  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Nguyên liệu</th><th>ĐV</th><th>SX</th><th>ĐB</th><th>Tồn HT</th><th>Tồn thực tế</th><th>Đơn giá/đvị</th><th></th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr data-item="${escapeHtml(r.itemName)}" data-unit="${escapeHtml(r.unit)}" data-computed="${r.computed}">
            <td>${escapeHtml(r.itemName)}</td>
            <td>${escapeHtml(r.unit)}</td>
            <td><input type="checkbox" class="stk-sx" ${r.sanXuat ? "checked" : ""} title="Dùng cho sản xuất" /></td>
            <td><input type="checkbox" class="stk-db" ${r.diemBan ? "checked" : ""} title="Dùng cho điểm bán" /></td>
            <td>${fmtNum(r.computed)}</td>
            <td><input type="number" class="stk-actual" min="0" step="0.01" placeholder="${fmtNum(r.computed)}" style="width:80px" /></td>
            <td><input type="number" class="stk-gia" min="0" step="1000" placeholder="đ" style="width:70px" /></td>
            <td class="entry-row-actions" style="flex-wrap:nowrap;">
              <button type="button" class="link-btn stk-save">Lưu</button>
              ${r.isCustom
                ? `<button type="button" class="link-btn stk-edit-custom">Sửa</button><button type="button" class="link-btn danger stk-del-custom">Xoá</button>`
                : (r.noHistory ? `<button type="button" class="link-btn danger stk-del-suggestion">Xoá</button>` : "")}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  $$(".stk-sx, .stk-db", el).forEach((cb) => {
    cb.addEventListener("change", async () => {
      const tr = cb.closest("tr");
      const name = tr.dataset.item;
      const unit = tr.dataset.unit;
      const sanXuat = $(".stk-sx", tr).checked;
      const diemBan = $(".stk-db", tr).checked;
      const existingId = state.itemCatalog[name]?.id || slugifyItemName(name);
      try {
        await setDoc(doc(db, "itemCatalog", existingId), {
          itemName: name, unit, sanXuat, diemBan, updatedAt: serverTimestamp(),
        }, { merge: true });
        state.itemCatalog[name] = { ...(state.itemCatalog[name] || {}), id: existingId, itemName: name, unit, sanXuat, diemBan };
        toast(`Đã lưu phân loại: ${name}`);
      } catch (err) {
        reportError(err, "Không lưu được phân loại: " + (err.message || ""));
      }
    });
  });

  $$(".stk-save", el).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tr = btn.closest("tr");
      const name = tr.dataset.item;
      const unit = tr.dataset.unit;
      const computed = parseFloat(tr.dataset.computed) || 0;
      const actualStr = $(".stk-actual", tr).value.trim();
      if (actualStr === "") { toast("Nhập số tồn thực tế trước khi lưu"); return; }
      const actual = parseFloat(actualStr) || 0;
      const delta = actual - computed;
      if (Math.abs(delta) < 1e-9) { toast("Không có thay đổi — số đã khớp với hệ thống"); return; }
      const donGia = delta > 0 ? (parseFloat($(".stk-gia", tr).value) || 0) : 0;
      btn.disabled = true;
      const payload = {
        uid: state.currentUser.uid,
        locationId: opKitchenId,
        date: todayISO(),
        itemName: name,
        unit,
        qty: delta,
        tien: donGia * delta,
        ghiChu: `Kiểm kê kho: chỉnh tồn từ ${fmtNum(computed)} thành ${fmtNum(actual)} ${unit}`,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      await saveOp(
        () => addDoc(collection(db, "ingredients"), payload),
        async (confirmed) => {
          toast(confirmed ? `Đã cập nhật tồn "${name}"` : "Đã lưu (chưa có mạng — sẽ tự đồng bộ)");
          stocktakeExtraItems = stocktakeExtraItems.filter((r) => r.itemName !== name);
          await loadAndRenderKho(opKitchenId);
        }
      );
      btn.disabled = false;
    });
  });

  $$(".stk-edit-custom", el).forEach((btn) => {
    btn.addEventListener("click", () => {
      const tr = btn.closest("tr");
      const name = tr.dataset.item;
      const unit = tr.dataset.unit;
      stocktakeExtraItems = stocktakeExtraItems.filter((r) => r.itemName !== name);
      $("#stocktake-new-item").value = name;
      $("#stocktake-new-unit").value = unit;
      renderStockTakeTable(opKitchenId);
      $("#stocktake-new-item").focus();
    });
  });

  $$(".stk-del-custom", el).forEach((btn) => {
    btn.addEventListener("click", () => {
      const tr = btn.closest("tr");
      const name = tr.dataset.item;
      stocktakeExtraItems = stocktakeExtraItems.filter((r) => r.itemName !== name);
      renderStockTakeTable(opKitchenId);
    });
  });

  // Xoá 1 nguyên liệu chưa từng có lịch sử (gợi ý mặc định không dùng tới,
  // hoặc nguyên liệu tự thêm/phân loại trước đây nhưng quán không dùng nữa)
  // khỏi danh sách Kiểm kê kho + Tồn kho hiện tại. Không xoá dữ liệu gì cả —
  // chỉ đánh dấu itemCatalog.an = true để lần sau ẩn đi; nếu sau này lại có
  // nhập/chuyển hàng thật cho nguyên liệu này thì nó tự hiện lại bình thường.
  $$(".stk-del-suggestion", el).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tr = btn.closest("tr");
      const name = tr.dataset.item;
      const unit = tr.dataset.unit;
      if (!confirm(`Xoá "${name}" khỏi danh sách Kiểm kê kho / Tồn kho hiện tại? Nguyên liệu này chưa có lịch sử nhập/chuyển hàng nên xoá không mất dữ liệu gì — nếu sau này nhập/chuyển hàng lại đúng tên này, nó sẽ tự hiện lại.`)) return;
      btn.disabled = true;
      try {
        const existingId = state.itemCatalog[name]?.id || slugifyItemName(name);
        await setDoc(doc(db, "itemCatalog", existingId), {
          itemName: name, unit, an: true, updatedAt: serverTimestamp(),
        }, { merge: true });
        state.itemCatalog[name] = { ...(state.itemCatalog[name] || {}), id: existingId, itemName: name, unit, an: true };
        toast(`Đã xoá "${name}" khỏi danh sách`);
        renderStockTakeTable(opKitchenId);
        renderStockTableUI();
      } catch (err) {
        reportError(err, "Không xoá được: " + (err.message || ""));
        btn.disabled = false;
      }
    });
  });
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
      .filter((r) => r.locationId === state.profile.locationId)
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
      .filter((r) => r.toLocationId === state.profile.locationId)
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

// Gợi ý số lượng (soLuong) nên chuẩn bị hôm nay cho từng điểm bán — trung
// bình các ngày cùng Thứ trong FORECAST_LOOKBACK_DAYS ngày gần nhất (xem
// suggestedQtyForWeekday() ở calc.js). Tính cho MỌI điểm bán đang hoạt động,
// không phụ thuộc bếp nào đang được chọn ở trên (1 bếp thường cấp cho nhiều
// điểm, và bếp nào cũng cần biết cần chuẩn bị bao nhiêu cho mỗi điểm).
async function loadAndRenderPrepSuggestion() {
  const el = $('[data-bind="prep-suggestion"]');
  if (!el) return;
  el.innerHTML = `<p class="empty-state">Đang tính…</p>`;
  try {
    const pLocs = pointLocations();
    if (!pLocs.length) { el.innerHTML = emptyState("Chưa có điểm bán nào"); return; }
    const today = todayISO();
    const from = addDays(today, -FORECAST_LOOKBACK_DAYS);
    const to = addDays(today, -1);
    const rows = await fetchEntriesByRange(from, to);
    el.innerHTML = pLocs.map(([id, l]) => {
      const rowsForLoc = rows.filter((r) => r.locationId === id);
      const qty = suggestedQtyForWeekday(rowsForLoc, today, FORECAST_LOOKBACK_DAYS);
      return `
        <div class="entry-card">
          <div class="entry-card-top">
            <span class="entry-date">${escapeHtml(l.name)}</span>
            <span class="entry-total">${qty == null ? "Chưa đủ dữ liệu" : fmtNum(qty) + " phần"}</span>
          </div>
        </div>
      `;
    }).join("");
  } catch (err) {
    console.error(err);
    el.innerHTML = emptyState("Không tính được gợi ý");
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
        ${r.hanSuDung ? `<span>HSD: ${formatDateVN(r.hanSuDung)}</span>` : ""}
        ${r.nhaCungCap ? `<span>NCC: ${escapeHtml(r.nhaCungCap)}${r.congNo ? ` <span class="badge-unpaid">Còn nợ</span>` : ` <span class="badge-paid">Đã trả</span>`}</span>` : ""}
      </div>
      ${r.ghiChu ? `<div class="entry-note">${escapeHtml(r.ghiChu)}</div>` : ""}
      ${receiptThumbHtml(r.anhHoaDon)}
      <div class="entry-row-actions">
        <button class="link-btn" data-ing-edit="${r.id}">Sửa</button>
        ${r.congNo ? `<button class="link-btn" data-ing-paid="${r.id}">Đánh dấu đã trả</button>` : ""}
        <button class="link-btn danger" data-ing-del="${r.id}">Xoá</button>
      </div>
    </div>
  `).join("");
}

// Trạng thái xác nhận nhận hàng của điểm bán cho 1 lần chuyển hàng —
// r.confirmed chưa có (undefined) = chưa ai xác nhận gì (mặc định của các
// phiếu cũ trước khi có tính năng này, và phiếu mới vừa tạo); true = điểm
// bán xác nhận đã nhận đủ; false (kèm issueNote) = điểm bán báo thiếu/sai.
function transferStatusBadge(r) {
  if (r.confirmed === true) return `<span class="badge-paid">Đã xác nhận nhận đủ</span>`;
  if (r.confirmed === false) return `<span class="badge-unpaid">Báo thiếu/sai</span>`;
  return `<span class="entry-off-badge">Chờ xác nhận</span>`;
}

function renderTransferCards(rows, showActions) {
  if (!rows.length) return "";
  return rows.map((r) => `
    <div class="ing-card" data-id="${r.id}">
      <div class="entry-card-top">
        <span class="entry-date">${formatDateVN(r.date)}${showActions ? " · " + escapeHtml(locationName(r.toLocationId)) : ""}</span>
        <span class="entry-total">${fmtNum(r.qty)} ${escapeHtml(r.unit)}</span>
      </div>
      <div class="entry-meta">
        <span>${escapeHtml(r.itemName)}${!showActions ? " · từ " + escapeHtml(locationName(r.fromLocationId)) : ""}</span>
        <span>${transferStatusBadge(r)}</span>
      </div>
      ${r.ghiChu ? `<div class="entry-note">${escapeHtml(r.ghiChu)}</div>` : ""}
      ${r.issueNote ? `<div class="entry-note">Điểm bán báo: ${escapeHtml(r.issueNote)}</div>` : ""}
      ${showActions ? `
      <div class="entry-row-actions">
        <button class="link-btn" data-trf-edit="${r.id}">Sửa</button>
        <button class="link-btn danger" data-trf-del="${r.id}">Xoá</button>
      </div>` : (r.confirmed === undefined ? `
      <div class="entry-row-actions">
        <button class="link-btn" data-trf-confirm="${r.id}">Xác nhận đã nhận</button>
        <button class="link-btn danger" data-trf-issue="${r.id}">Báo thiếu/sai</button>
      </div>` : "")}
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

// Event delegation cho nguyên liệu / chuyển hàng / đặt hàng trong view-root
// (view-root tồn tại xuyên suốt các lần render — đăng ký 1 lần duy nhất ở
// đây, không đăng ký lại mỗi lần renderKho()).
viewRoot.addEventListener("click", async (e) => {
  const ingEditBtn = e.target.closest("[data-ing-edit]");
  const ingDelBtn = e.target.closest("[data-ing-del]");
  if (ingEditBtn) {
    const id = ingEditBtn.dataset.ingEdit;
    const row = ingCacheGlobal.find((r) => r.id === id);
    if (!row) return;
    editingIngId = id;
    // Nới min nếu dòng đang sửa cũ hơn giới hạn chuẩn, để không bị trình
    // duyệt coi ngày hiện có là "không hợp lệ" khi chưa hề đổi gì.
    if (row.date < $("#ing-date").min) $("#ing-date").min = row.date;
    $("#ing-date").value = row.date;
    $("#ing-item").value = row.itemName || "";
    $("#ing-unit").value = row.unit || "kg";
    $("#ing-qty").value = row.qty || "";
    $("#ing-tien").value = row.tien || "";
    $("#ing-hansudung").value = row.hanSuDung || "";
    $("#ing-ncc").value = row.nhaCungCap || "";
    $("#ing-congno").checked = !!row.congNo;
    $("#ing-ghichu").value = row.ghiChu || "";
    ingReceiptCtl?.set(row.anhHoaDon || "");
    $("#btn-ing-cancel").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  if (ingDelBtn) {
    const id = ingDelBtn.dataset.ingDel;
    const row = ingCacheGlobal.find((r) => r.id === id);
    if (!confirm("Xoá lần nhập nguyên liệu này?")) return;
    try {
      await deleteDoc(doc(db, "ingredients", id));
      logChange("ingredients", id, "delete", row, null);
      toast("Đã xoá");
      await loadAndRenderKho();
    } catch (err) { reportError(err, "Không xoá được"); }
  }

  const ingPaidBtn = e.target.closest("[data-ing-paid]");
  if (ingPaidBtn) {
    const id = ingPaidBtn.dataset.ingPaid;
    const row = ingCacheGlobal.find((r) => r.id === id);
    if (!row) return;
    try {
      await updateDoc(doc(db, "ingredients", id), { congNo: false });
      logChange("ingredients", id, "update", row, { congNo: false });
      toast(`Đã đánh dấu đã trả: ${row.nhaCungCap || ""}`);
      await loadAndRenderKho();
    } catch (err) { reportError(err, "Không cập nhật được: " + (err.message || "")); }
  }

  const trfEditBtn = e.target.closest("[data-trf-edit]");
  const trfDelBtn = e.target.closest("[data-trf-del]");
  if (trfEditBtn) {
    const id = trfEditBtn.dataset.trfEdit;
    const row = transferCacheGlobal.find((r) => r.id === id);
    if (!row) return;
    editingTransferId = id;
    if (row.date < $("#trf-date").min) $("#trf-date").min = row.date;
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
    const row = transferCacheGlobal.find((r) => r.id === id);
    if (!confirm("Xoá lần chuyển hàng này?")) return;
    try {
      await deleteDoc(doc(db, "transfers", id));
      logChange("transfers", id, "delete", row, null);
      toast("Đã xoá");
      await loadAndRenderKho();
    } catch (err) { reportError(err, "Không xoá được"); }
  }

  // Xác nhận nhận hàng 2 chiều: điểm bán xác nhận đã nhận đủ, hoặc báo
  // thiếu/sai để bếp biết mà xử lý — thay vì bếp chỉ biết "đã gửi" mà không
  // rõ điểm bán có thực sự nhận đủ/đúng hay không.
  const trfConfirmBtn = e.target.closest("[data-trf-confirm]");
  const trfIssueBtn = e.target.closest("[data-trf-issue]");
  if (trfConfirmBtn) {
    const id = trfConfirmBtn.dataset.trfConfirm;
    if (!confirm("Xác nhận đã nhận đủ hàng này?")) return;
    try {
      await updateDoc(doc(db, "transfers", id), { confirmed: true, confirmedAt: serverTimestamp(), issueNote: "" });
      toast("Đã xác nhận nhận hàng");
      await loadAndRenderReceived();
    } catch (err) { reportError(err, "Không xác nhận được: " + (err.message || "")); }
  }
  if (trfIssueBtn) {
    const id = trfIssueBtn.dataset.trfIssue;
    const note = prompt("Mô tả ngắn gọn vấn đề (thiếu bao nhiêu, sai gì...):");
    if (note === null) return; // bấm Huỷ ở hộp thoại
    try {
      await updateDoc(doc(db, "transfers", id), {
        confirmed: false, confirmedAt: serverTimestamp(),
        issueNote: note.trim() || "Có vấn đề (chưa ghi rõ chi tiết)",
      });
      toast("Đã gửi báo cáo thiếu/sai tới bếp");
      await loadAndRenderReceived();
    } catch (err) { reportError(err, "Không gửi được báo cáo: " + (err.message || "")); }
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
    } catch (err) { reportError(err, "Không cập nhật được"); }
  }
  if (orderCancelBtn) {
    const id = orderCancelBtn.dataset.orderCancel;
    if (!confirm("Huỷ đơn đặt hàng này?")) return;
    try {
      await updateDoc(doc(db, "orders", id), { status: "huy", updatedAt: serverTimestamp() });
      toast("Đã huỷ đơn");
      await loadAndRenderMyOrders();
    } catch (err) { reportError(err, "Không huỷ được"); }
  }
});
