/* ===================== CHẤM CÔNG ===================== */
import {
  addDoc, collection, deleteDoc, doc, getDoc, serverTimestamp, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db } from "../firebase-init.js";
import { $, $$, viewRoot, mount, emptyState, toast, reportError } from "../ui.js";
import { state, isAdmin, locationGiaBan, staffName, locationName } from "../state.js";
import { fetchEntriesByUid, logChange, saveOp } from "../data.js";
import { addDays, escapeHtml, fmt, fmtNum, formatDateVN, matchesSearch, mondayOf, todayISO } from "../calc.js";
import { DATE_ENTRY_PAST_DAYS } from "../constants.js";

let entryCacheForUser = [];
// uid mà admin đang xem/sửa phiếu chấm công (mặc định là chính admin). Nhân
// viên thường luôn quản lý phiếu của chính mình, không đổi được giá trị này.
let entryTargetUid = null;
let editingEntryId = null;
let entryListLimit = 30; // "Xem thêm" — tăng dần khi bấm

function currentEntryLocationId() {
  return state.staffDirectory[entryTargetUid]?.locationId ?? state.profile.locationId;
}

export async function renderChamCong() {
  mount("cham-cong");
  editingEntryId = null;
  entryListLimit = 30;

  if (!isAdmin() && !state.profile.locationId) {
    viewRoot.innerHTML = emptyState("Bạn chưa được gán điểm bán nên chưa thể chấm công. Liên hệ chủ quán.");
    return;
  }

  entryTargetUid = state.currentUser.uid;
  const staffSelectWrap = $('[data-bind="entry-staff-select"]');
  if (isAdmin() && staffSelectWrap) {
    const staffList = Object.entries(state.staffDirectory)
      .filter(([, u]) => u.active !== false && u.locationId)
      .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || "", "vi"));
    if (staffList.length) {
      const defaultUid = staffList.some(([uid]) => uid === state.currentUser.uid) ? state.currentUser.uid : staffList[0][0];
      entryTargetUid = defaultUid;
      staffSelectWrap.hidden = false;
      staffSelectWrap.innerHTML = `<label class="field"><span>Xem / sửa chấm công của</span>
        <select id="entry-staff-select">
          ${staffList.map(([uid, u]) => `<option value="${uid}" ${uid === defaultUid ? "selected" : ""}>${escapeHtml(u.name || "(chưa đặt tên)")}${uid === state.currentUser.uid ? " (bạn)" : ""} · ${escapeHtml(locationName(u.locationId))}</option>`).join("")}
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
    if (isAdmin() && entryTargetUid !== state.currentUser.uid) {
      const nm = state.staffDirectory[entryTargetUid]?.name || "Nhân viên";
      locBadge.textContent = `${nm} · ${locationName(locId)}`;
    } else {
      locBadge.textContent = locationName(locId);
    }
  }
  updateEntryLocationBadge();

  const dateEl = $("#entry-date");
  dateEl.min = addDays(todayISO(), -DATE_ENTRY_PAST_DAYS);
  dateEl.max = todayISO();
  dateEl.value = todayISO();
  $("#entry-luong").value = state.locationsDirectory[currentEntryLocationId()]?.luongMacDinh ?? state.settings.luongMacDinh ?? "";

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
    if (dateEl.value < dateEl.min || dateEl.value > dateEl.max) {
      toast(`Chỉ được chọn ngày từ ${formatDateVN(dateEl.min)} đến ${formatDateVN(dateEl.max)}.`);
      return;
    }
    const off = offEl.checked;
    const targetLocationId = currentEntryLocationId();
    if (!targetLocationId) {
      toast(entryTargetUid === state.currentUser.uid
        ? "Tài khoản của bạn chưa được gán điểm bán. Vào Quản lý > Nhân sự để gán điểm bán trước khi chấm công."
        : "Nhân viên này chưa được gán điểm bán.");
      return;
    }
    const payload = {
      uid: entryTargetUid,
      name: state.staffDirectory[entryTargetUid]?.name || (entryTargetUid === state.currentUser.uid ? (state.profile.name || "") : ""),
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
    // Mỗi nhân viên chỉ nên có 1 phiếu/ngày — chặn tạo phiếu MỚI (không áp
    // dụng khi đang Sửa) trùng ngày với 1 phiếu đã có, để tránh bấm nhầm/bấm
    // đúp ra 2 phiếu cùng ngày, làm doanh thu + lương bị cộng đôi mà không
    // ai để ý. Nếu thật sự cần sửa số liệu ngày đó, bấm "Sửa" ở phiếu cũ.
    if (!wasEditing && entryCacheForUser.some((r) => r.date === dateEl.value)) {
      toast(`Đã có phiếu chấm công ngày ${formatDateVN(dateEl.value)} rồi — bấm "Sửa" ở phiếu đó thay vì tạo phiếu mới.`);
      return;
    }
    if (!wasEditing) {
      payload.createdAt = serverTimestamp();
      // Chụp lại giá bán của điểm bán NGAY LÚC TẠO phiếu — chỉ đặt 1 lần khi
      // tạo mới, cố tình KHÔNG ghi đè lại mỗi lần sửa phiếu sau này (nếu
      // không, sửa phiếu cũ sẽ vô tình cập nhật doanh thu phiếu đó theo giá
      // bán MỚI NHẤT thay vì giá đúng lúc bán). Xem entryGiaBan() ở state.js.
      payload.giaBanTaiThoiDiem = locationGiaBan(targetLocationId);
    }
    const beforeEntryRow = wasEditing ? entryCacheForUser.find((r) => r.id === editingEntryId) : null;
    const entryBtn = e.submitter;
    if (entryBtn) entryBtn.disabled = true;
    try {
      await saveOp(
        () => (wasEditing ? updateDoc(doc(db, "entries", editingEntryId), payload) : addDoc(collection(db, "entries"), payload)),
        async (confirmed) => {
          if (wasEditing) logChange("entries", editingEntryId, "update", beforeEntryRow, payload);
          toast(wasEditing ? "Đã cập nhật phiếu chấm công" : (confirmed ? "Đã lưu phiếu chấm công" : "Đã lưu phiếu (chưa có mạng — sẽ tự đồng bộ)"));
          resetEntryForm();
          await loadAndRenderEntryList();
        }
      );
    } finally {
      if (entryBtn) entryBtn.disabled = false;
    }
  });

  $("#entry-filter").addEventListener("change", () => { entryListLimit = 30; renderEntryListFiltered(); });
  $("#entry-search").addEventListener("input", () => { entryListLimit = 30; renderEntryListFiltered(); });
  $('[data-bind="entry-list-more"]').addEventListener("click", () => { entryListLimit += 30; renderEntryListFiltered(); });

  await loadAndRenderEntryList();
}

// Tuần chứa phiếu này đã được chủ quán quyết toán (tick "Đã thanh toán" ở
// Báo cáo) chưa — dùng để CẢNH BÁO (không chặn) khi nhân viên/chủ quán sửa
// hoặc xoá 1 phiếu chấm công của tuần đã trả lương, để tránh vô tình làm số
// tiền đã trả không còn khớp với dữ liệu chấm công nữa mà không ai để ý.
async function isSettlementPaid(row) {
  if (!row?.uid || !row?.date) return false;
  try {
    const snap = await getDoc(doc(db, "settlements", `${row.uid}_${mondayOf(row.date)}`));
    return !!(snap.exists() && snap.data().paid);
  } catch (err) {
    console.error(err);
    return false; // Tra cứu lỗi (vd mất mạng) thì thôi, không cảnh báo thêm — không phải lỗi chặn thao tác chính.
  }
}

function resetEntryForm() {
  editingEntryId = null;
  const f = $("#form-entry");
  if (!f) return;
  f.reset();
  // form.reset() không đụng tới min/max (chỉ reset value) — đặt lại min về
  // mức chuẩn phòng khi lần sửa trước đó đã nới min để hiện được 1 phiếu cũ
  // hơn (xem nhánh editBtn bên dưới).
  $("#entry-date").min = addDays(todayISO(), -DATE_ENTRY_PAST_DAYS);
  $("#entry-date").value = todayISO();
  $("#entry-luong").value = state.locationsDirectory[currentEntryLocationId()]?.luongMacDinh ?? state.settings.luongMacDinh ?? "";
  $("#btn-entry-cancel").hidden = true;
  $$("input", $("#entry-work-fields")).forEach((i) => (i.disabled = false));
}

async function loadAndRenderEntryList() {
  const list = $('[data-bind="entry-list"]');
  list.innerHTML = `<p class="empty-state">Đang tải…</p>`;
  try {
    entryCacheForUser = await fetchEntriesByUid(entryTargetUid || state.currentUser.uid);
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

// Dùng chung với Trang chủ (renderTrangChu gọi hàm này để hiện danh sách
// phiếu chấm công gần đây) — vì vậy được export thay vì để riêng module này.
export function renderEntryCards(rows, showName, showActions = false, showLocation = false) {
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

// Event delegation cho các nút sửa/xoá phiếu chấm công trong view-root
// (view-root tồn tại xuyên suốt các lần render — đăng ký 1 lần duy nhất ở
// đây, không đăng ký lại mỗi lần renderChamCong()).
viewRoot.addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit]");
  const delBtn = e.target.closest("[data-del]");
  if (editBtn && $("#form-entry")) {
    const id = editBtn.dataset.edit;
    const row = entryCacheForUser.find((r) => r.id === id);
    if (!row) return;
    if (await isSettlementPaid(row)) {
      if (!confirm("Tuần này đã được quyết toán (đánh dấu Đã thanh toán) — sửa phiếu có thể làm số liệu không còn khớp với số đã trả. Vẫn muốn sửa?")) return;
    }
    editingEntryId = id;
    // Nới min nếu phiếu đang sửa cũ hơn giới hạn chuẩn, để không bị trình
    // duyệt coi ngày hiện có của phiếu là "không hợp lệ" khi chưa hề đổi gì.
    if (row.date < $("#entry-date").min) $("#entry-date").min = row.date;
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
    const row = entryCacheForUser.find((r) => r.id === id);
    const paidWarning = row && await isSettlementPaid(row)
      ? "Tuần này đã được quyết toán (đánh dấu Đã thanh toán) — xoá phiếu có thể làm số liệu không còn khớp với số đã trả.\n\n"
      : "";
    if (!confirm(paidWarning + "Xoá phiếu chấm công này?")) return;
    try {
      await deleteDoc(doc(db, "entries", id));
      logChange("entries", id, "delete", row, null);
      toast("Đã xoá phiếu");
      await loadAndRenderEntryList();
    } catch (err) { reportError(err, "Không xoá được"); }
  }
});
