/* ===================== BÁO CÁO ===================== */
import { doc, getDoc, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db } from "../firebase-init.js";
import { $, $$, mount, emptyState, toast, reportError } from "../ui.js";
import { state, activeLocations, locationGiaBan, locationName, staffName } from "../state.js";
import { computeGiaVonPerPhan, fetchEntriesByRange, fetchIngredientsByRange, fetchThuChiByRange } from "../data.js";
import { addDays, escapeHtml, fmt, fmtNum, isoLocal, mondayOf, todayISO, weekdayLabel } from "../calc.js";

let reportEntriesCache = [];
let reportIngCache = [];
let reportThuChiCache = [];

// Quyết toán theo tuần: lọc "Tất cả / Chưa thanh toán / Đã thanh toán" +
// cache dữ liệu để đổi bộ lọc/tick thanh toán không phải gọi lại Firestore.
let settleFilter = "tatca";
let settleGroupsCache = {};
let settleDocsCache = {};

export async function renderBaoCao() {
  mount("bao-cao");
  const fromEl = $("#report-from"), toEl = $("#report-to");
  const wkStart = mondayOf(todayISO());
  fromEl.value = wkStart;
  toEl.value = addDays(wkStart, 5);

  settleFilter = "tatca";
  $$('[data-settle-filter]').forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.settleFilter === "tatca");
    chip.addEventListener("click", () => {
      settleFilter = chip.dataset.settleFilter;
      $$('[data-settle-filter]').forEach((c) => c.classList.toggle("active", c === chip));
      renderSettlementList();
    });
  });

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

async function loadReport() {
  const from = $("#report-from").value, to = $("#report-to").value;
  const locFilter = $("#report-location").value;
  const sumEl = $('[data-bind="report-summary"]');
  sumEl.innerHTML = `<div class="stat-card"><div class="label">Đang tải…</div></div>`;
  let giaVonPerPhan;
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

  const selectedIsPoint = locFilter && state.locationsDirectory[locFilter]?.type === "point";
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
    sumEl.insertAdjacentHTML("beforeend", `<p class="hint-text" style="grid-column:1/-1;">Giá vốn NL ước tính = ${fmt(giaVonPerPhan)}/phần × số lượng bán, theo định mức nguyên liệu đã đặt — áp dụng được cho cả từng điểm bán.</p>`);
  } else if (selectedIsPoint) {
    sumEl.insertAdjacentHTML("beforeend", `<p class="hint-text" style="grid-column:1/-1;">Chi phí nguyên liệu phát sinh chung ở bếp trung tâm nên không chia theo từng điểm bán — xem ở lựa chọn "Tất cả điểm" hoặc điểm bếp.</p>`);
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
    <p class="hint-text">Chi phí nguyên liệu thực nhập toàn hệ thống (bếp trung tâm): <b>${fmt(chiPhiNLTong)}</b>${coBOM ? " — dùng để đối chiếu với giá vốn ước tính theo định mức ở bảng trên." : " — chưa phân bổ vào từng điểm ở bảng trên (chưa có định mức nguyên liệu/phần nào được đặt)."}</p>
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

  const chartBox = document.getElementById("daily-chart-box");
  if (!chartBox) {
    const el = $('[data-bind="report-by-staff"]');
    el.insertAdjacentHTML("afterend", `<div class="ticket" id="daily-chart-box" style="margin-top:14px;"><p class="eyebrow">Doanh thu theo ngày</p><div id="daily-chart-inner"></div></div>`);
  }
  document.getElementById("daily-chart-inner").innerHTML = chartInner;
}

// Tải dữ liệu quyết toán (tổng lương từng nhân viên/tuần + trạng thái đã
// thanh toán) rồi cache lại — renderSettlementList() phía dưới lo phần sắp
// xếp/lọc/vẽ, để đổi bộ lọc Tất cả/Chưa/Đã thanh toán không phải gọi lại
// Firestore mỗi lần bấm.
async function renderSettlements(entries) {
  const groups = {};
  entries.forEach((r) => {
    const wk = mondayOf(r.date);
    const key = r.uid + "_" + wk;
    groups[key] = groups[key] || { uid: r.uid, name: r.name || staffName(r.uid), week: wk, total: 0 };
    groups[key].total += r.tong || 0;
  });
  settleGroupsCache = groups;
  const keys = Object.keys(groups);

  let settlementDocs = {};
  if (keys.length) {
    try {
      const results = await Promise.all(keys.map((k) => getDoc(doc(db, "settlements", k))));
      results.forEach((snap, i) => { if (snap.exists()) settlementDocs[keys[i]] = snap.data(); });
    } catch (err) {
      // Không im lặng ở đây: nếu lỗi, mọi tuần đều rơi về "chưa thanh toán"
      // (vì không đọc được settlementDocs) dù thực ra có thể đã trả rồi —
      // ảnh hưởng trực tiếp tới tiền, phải báo rõ để chủ quán không nhầm.
      reportError(err, "Không tải được trạng thái quyết toán — số Đã/Chưa thanh toán bên dưới có thể không chính xác, thử tải lại trang.");
    }
  }
  settleDocsCache = settlementDocs;

  renderSettlementList();
}

// Banner nhắc tổng số phiếu + tổng tiền còn chưa thanh toán — luôn tính trên
// TOÀN BỘ phiếu đã tải (không theo bộ lọc đang xem), để dù đang lọc "Đã thanh
// toán" cũng không quên mất còn ai chưa trả lương.
function renderSettleSummary() {
  const el = $('[data-bind="settle-summary"]');
  if (!el) return;
  const groups = settleGroupsCache, docs = settleDocsCache;
  const unpaidKeys = Object.keys(groups).filter((k) => !docs[k]?.paid);
  if (!unpaidKeys.length) { el.innerHTML = ""; return; }
  const total = unpaidKeys.reduce((s, k) => s + groups[k].total + (docs[k]?.adjustment || 0), 0);
  el.innerHTML = `
    <div class="reminder-banner gold">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
      <span>Còn <b>${unpaidKeys.length}</b> phiếu chưa thanh toán, tổng <b>${fmt(total)}</b>.</span>
    </div>`;
}

// Vẽ lại danh sách quyết toán từ dữ liệu đã cache (không gọi Firestore) —
// dùng cho lần tải đầu và mỗi khi đổi bộ lọc/tick thanh toán. Sắp xếp: tuần
// gần nhất trước, trong cùng tuần thì phiếu CHƯA thanh toán lên trước (dễ
// thấy ai còn cần trả lương), rồi mới tới tên nhân viên.
function renderSettlementList() {
  const groups = settleGroupsCache, settlementDocs = settleDocsCache;
  const el = $('[data-bind="report-settlements"]');
  if (!el) return;
  renderSettleSummary();

  const keys = Object.keys(groups);
  if (!keys.length) { el.innerHTML = emptyState("Không có tuần nào để quyết toán trong khoảng đã chọn"); return; }

  keys.sort((a, b) => {
    const ga = groups[a], gb = groups[b];
    if (ga.week !== gb.week) return gb.week.localeCompare(ga.week);
    const pa = settlementDocs[a]?.paid ? 1 : 0, pb = settlementDocs[b]?.paid ? 1 : 0;
    if (pa !== pb) return pa - pb;
    return ga.name.localeCompare(gb.name, "vi");
  });

  const visibleKeys = keys.filter((k) => {
    const paid = !!settlementDocs[k]?.paid;
    if (settleFilter === "chua") return !paid;
    if (settleFilter === "da") return paid;
    return true;
  });

  if (!visibleKeys.length) {
    el.innerHTML = emptyState(settleFilter === "chua" ? "Không còn phiếu nào chưa thanh toán 🎉" : "Không có phiếu nào khớp bộ lọc đang chọn");
    return;
  }

  el.innerHTML = visibleKeys.map((k) => {
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
        settleDocsCache[key] = { ...(settleDocsCache[key] || {}), adjustment: adj, note, paid };
        renderSettlementList();
      } catch (err) { reportError(err, "Không lưu được quyết toán"); }
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
  const csv = "﻿" + rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `so-xoi_${from}_den_${to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
