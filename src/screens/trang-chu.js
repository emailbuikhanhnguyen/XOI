/* ===================== TRANG CHỦ ===================== */
import { $, $$, mount, emptyState } from "../ui.js";
import { state, isAdmin, isKitchenContext, activeLocations, entryGiaBan, locationName } from "../state.js";
import { fetchEntriesByRange, fetchEntriesByUid, fetchIngredientsByRange, fetchTransfersByRange } from "../data.js";
import { addDays, escapeHtml, fmt, formatDateVN, mondayOf, todayISO } from "../calc.js";
import { STOCK_WINDOW_DAYS } from "../constants.js";
import { renderEntryCards } from "./cham-cong.js";

export async function renderTrangChu() {
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
      const totalDoanhThu = worked.reduce((s, r) => s + (r.soLuong || 0) * entryGiaBan(r), 0);
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
          const dt = locRows.reduce((s, r) => s + (r.soLuong || 0) * entryGiaBan(r), 0);
          return `<div class="stat-card"><div class="label">${escapeHtml(l.name)}</div><div class="value">${fmt(dt)}</div></div>`;
        }).join("") : emptyState("Chưa có điểm bán nào — vào mục Quản lý để thêm");
      }
      await renderAttendanceStatus(todayISO());
      await renderHomeReminders();
    } else {
      const rows = await fetchEntriesByUid(state.currentUser.uid);
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
  await renderLocationLeaderboard();
}

// Xếp hạng các điểm bán theo doanh thu TUẦN NÀY (Thứ 2 - hôm nay) — hiện cho
// MỌI người dùng (kể cả nhân viên), không riêng chủ quán, để tạo động lực
// nhẹ nhàng giữa các điểm bán với nhau. Cố ý im lặng khi lỗi (chỉ
// console.error): đây chỉ là 1 khối phụ mang tính động viên trên Trang chủ,
// lỗi ở đây không nên làm phiền hay che mất phần thống kê chính phía trên.
async function renderLocationLeaderboard() {
  const el = $('[data-bind="location-leaderboard"]');
  if (!el) return;
  const pLocs = activeLocations().filter(([, l]) => l.type === "point");
  if (pLocs.length < 2) { el.innerHTML = ""; return; } // chỉ 0-1 điểm thì "xếp hạng" không có ý nghĩa gì
  try {
    const weekStart = mondayOf(todayISO());
    const rows = await fetchEntriesByRange(weekStart, todayISO());
    const worked = rows.filter((r) => !r.offDay);
    const totals = pLocs.map(([id, l]) => {
      const locRows = worked.filter((r) => r.locationId === id);
      const doanhThu = locRows.reduce((s, r) => s + (r.soLuong || 0) * entryGiaBan(r), 0);
      return { name: l.name, doanhThu };
    }).sort((a, b) => b.doanhThu - a.doanhThu);
    el.innerHTML = `
      <h3 class="section-heading">Xếp hạng điểm bán tuần này</h3>
      <div class="stack">
        ${totals.map((t, i) => `
          <div class="entry-card">
            <div class="entry-card-top">
              <span class="entry-date">#${i + 1} · ${escapeHtml(t.name)}</span>
              <span class="entry-total">${fmt(t.doanhThu)}</span>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  } catch (err) {
    console.error(err);
    el.innerHTML = "";
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
      const missing = Object.entries(state.staffDirectory).filter(([uid, u]) => u.active !== false && u.locationId && !byUid[uid]);
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
      const th = state.itemCatalog[name]?.threshold;
      return th && ton < th;
    });
    if (lowItems.length) {
      banners.push(`<div class="reminder-banner gold">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
          <span>Sắp hết ${lowItems.length} nguyên liệu ở bếp: ${lowItems.map(([name]) => escapeHtml(name)).join(", ")}.</span>
      </div>`);
    }
    // Cố ý im lặng khi lỗi (chỉ console.error, không toast): đây chỉ là các
    // banner nhắc nhở phụ trên Trang chủ, tự tải lại mỗi lần vào màn hình —
    // toast lỗi ở đây sẽ làm phiền (nhất là khi mất mạng, vốn là chuyện bình
    // thường của app này) mà không mang lại giá trị gì hơn việc banner đơn
    // giản không hiện ra.
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

    const staffList = Object.entries(state.staffDirectory).filter(([, u]) => u.active !== false && u.locationId);
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
          <span>Số lượng: <b>${fmt(entry.soLuong)}</b></span>
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
