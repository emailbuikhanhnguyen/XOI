/* ===================== QUẢN LÝ (Điểm bán + Nhân viên) ===================== */
import { firebaseConfig } from "../../firebase-config.js";
import { deleteApp, initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  createUserWithEmailAndPassword, getAuth, sendPasswordResetEmail, signOut,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  addDoc, collection, deleteDoc, doc, getDocs, serverTimestamp, setDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { auth, db } from "../firebase-init.js";
import { $, $$, viewRoot, mount, emptyState, toast, reportError } from "../ui.js";
import { state, activeLocations, locationName } from "../state.js";
import { loadLocationsDirectory, loadStaffDirectory } from "../data.js";
import { escapeHtml, fmt } from "../calc.js";

let editingLocationId = null;
let editingStaffUid = null;

export async function renderQuanLy() {
  mount("quan-ly");
  editingStaffUid = null;

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
    } catch (err) { reportError(err, "Không lưu được điểm bán"); }
  });
  $("#btn-loc-cancel").addEventListener("click", () => resetLocationForm());

  const cleanAllBtn = $("#btn-clean-all-test");
  if (cleanAllBtn) {
    cleanAllBtn.addEventListener("click", async () => {
      if (!confirm("Xoá TOÀN BỘ dữ liệu test (phiếu chấm công, nhập kho, chuyển hàng, thu chi của nhân viên TEST NV hoặc gắn với điểm bán đã xoá, và các tài khoản TEST NV)? Không thể hoàn tác.")) return;
      cleanAllBtn.disabled = true;
      try {
        const validLocIds = new Set(Object.keys(state.locationsDirectory));
        const testStaffUids = new Set(
          Object.entries(state.staffDirectory)
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
        reportError(err, "Không dọn hết được: " + (err.message || ""));
      } finally {
        cleanAllBtn.disabled = false;
      }
    });
  }
  const cleanTestBtn = $("#btn-loc-clean-test");
  if (cleanTestBtn) {
    cleanTestBtn.addEventListener("click", async () => {
      const testEntries = Object.entries(state.locationsDirectory).filter(([, l]) => (l.name || "").trim().toUpperCase().startsWith("TEST"));
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
        reportError(err, "Không xoá hết được: " + (err.message || ""));
      } finally {
        cleanTestBtn.disabled = false;
      }
    });
  }

  $("#form-staff").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#staff-name").value.trim();
    const role = $("#staff-role").value;
    const staffLocationId = $("#staff-location").value;
    if (!staffLocationId) { toast("Chọn điểm bán cho nhân viên"); return; }
    const btn = e.submitter;
    btn.disabled = true;

    if (editingStaffUid) {
      // Sửa thông tin nhân viên có sẵn — không đụng tới email/mật khẩu đăng
      // nhập (đổi email tài khoản người khác cần Admin SDK, app này không có).
      try {
        await updateDoc(doc(db, "users", editingStaffUid), {
          name, role, locationId: staffLocationId, updatedAt: serverTimestamp(),
        });
        toast(`Đã cập nhật thông tin: ${name}`);
        resetStaffForm();
        await loadStaffDirectory();
        renderStaffList();
      } catch (err) {
        reportError(err, "Không cập nhật được: " + (err.message || ""));
      } finally {
        btn.disabled = false;
      }
      return;
    }

    const email = $("#staff-email").value.trim();
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
        reportError(mailErr, `Đã tạo tài khoản cho ${name}, nhưng gửi email đặt mật khẩu thất bại — bấm "Gửi lại email đổi mật khẩu" ở danh sách bên dưới để thử lại.`);
      }
      $("#form-staff").reset();
      await loadStaffDirectory();
      renderStaffList();
    } catch (err) {
      reportError(err, err.code === "auth/email-already-in-use" ? "Email đã được sử dụng" : "Không tạo được tài khoản");
    } finally {
      btn.disabled = false;
    }
  });
  $("#btn-staff-cancel").addEventListener("click", () => resetStaffForm());

  populateStaffLocationSelect();
  renderLocationList();
  await loadStaffDirectory();
  renderStaffList();
}

function resetStaffForm() {
  editingStaffUid = null;
  const f = $("#form-staff");
  if (!f) return;
  f.reset();
  $("#btn-staff-cancel").hidden = true;
  $('[data-bind="staff-form-title"]').textContent = "Thêm nhân viên";
  $('[data-bind="staff-submit-btn"]').textContent = "Tạo tài khoản";
  $('[data-bind="staff-email-field"]').hidden = false;
  $('[data-bind="staff-email-hint"]').hidden = false;
  $("#staff-email").required = true;
}

// Lưu ý: màn hình chỉnh "Định mức nguyên liệu / phần & cảnh báo tồn kho" đã
// được bỏ khỏi Quản lý theo yêu cầu chủ quán (đợt 6) — 2 tính năng phụ thuộc
// (cảnh báo tồn kho thấp ở Kho, giá vốn NL theo định mức ở Báo cáo) vẫn hoạt
// động bình thường dựa trên dữ liệu itemCatalog đã có sẵn (qtyPerPortion,
// threshold), chỉ là không còn màn hình để thêm/sửa các giá trị đó nữa. Mục
// phân loại "Sản xuất/Điểm bán" (sanXuat, diemBan) vẫn chỉnh được — xem
// renderStockTakeTable() ở màn Kho.

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
  const rows = Object.entries(state.locationsDirectory).sort((a, b) => (a[1].type === "kitchen" ? -1 : 1) - (b[1].type === "kitchen" ? -1 : 1));
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
  const rows = Object.entries(state.staffDirectory).sort((a, b) => (a[1].role === "admin" ? -1 : 1));
  if (!rows.length) { el.innerHTML = emptyState("Chưa có nhân viên nào"); return; }
  el.innerHTML = rows.map(([uid, u]) => `
    <div class="staff-card" data-uid="${uid}">
      <div class="entry-card-top">
        <span class="entry-date">${escapeHtml(u.name || "(chưa đặt tên)")}</span>
        <span class="${u.role === "admin" ? "badge-paid" : "badge-unpaid"}" style="background:${u.role === "admin" ? "var(--gold-tint)" : "var(--green-tint)"};color:${u.role === "admin" ? "var(--gold)" : "var(--green-dark)"}">${u.role === "admin" ? "Chủ quán" : "Nhân viên"}</span>
      </div>
      <div class="entry-meta"><span>${escapeHtml(u.email || "")}</span><span>${escapeHtml(locationName(u.locationId))}</span></div>
      <div class="entry-row-actions">
        <button class="link-btn" data-staff-edit="${uid}">Sửa</button>
        ${u.email ? `<button class="link-btn" data-resend-reset="${uid}">Gửi lại email đổi mật khẩu</button>` : ""}
        ${uid !== state.currentUser.uid ? `<button class="link-btn" data-toggle-active="${uid}">${u.active === false ? "Kích hoạt lại" : "Vô hiệu hoá"}</button>` : ""}
        ${uid !== state.currentUser.uid ? `<button class="link-btn danger" data-staff-del="${uid}">Xoá</button>` : ""}
      </div>
      ${uid === state.currentUser.uid ? `<div class="entry-note">Tài khoản của bạn</div>` : ""}
    </div>
  `).join("");

  $$("[data-staff-edit]", el).forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = btn.dataset.staffEdit;
      const u = state.staffDirectory[uid];
      if (!u) return;
      editingStaffUid = uid;
      $("#staff-name").value = u.name || "";
      $("#staff-role").value = u.role === "admin" ? "admin" : "staff";
      $("#staff-location").value = u.locationId || "";
      $('[data-bind="staff-form-title"]').textContent = `Sửa thông tin: ${u.name || "(chưa đặt tên)"}`;
      $('[data-bind="staff-submit-btn"]').textContent = "Cập nhật";
      $('[data-bind="staff-email-field"]').hidden = true;
      $('[data-bind="staff-email-hint"]').hidden = true;
      $("#staff-email").required = false;
      $("#btn-staff-cancel").hidden = false;
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  $$("[data-resend-reset]", el).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.resendReset;
      const u = state.staffDirectory[uid];
      if (!u?.email) return;
      try {
        await sendPasswordResetEmail(auth, u.email);
        toast("Đã gửi email đổi mật khẩu tới " + u.email);
      } catch (err) { reportError(err, "Không gửi được email"); }
    });
  });

  $$("[data-toggle-active]", el).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.toggleActive;
      const cur = state.staffDirectory[uid];
      try {
        await updateDoc(doc(db, "users", uid), { active: !(cur.active !== false) });
        toast("Đã cập nhật trạng thái");
        await loadStaffDirectory();
        renderStaffList();
      } catch (err) { reportError(err, "Không cập nhật được"); }
    });
  });

  $$("[data-staff-del]", el).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.staffDel;
      const u = state.staffDirectory[uid];
      if (!confirm(`Xoá hồ sơ nhân viên "${u?.name || ""}"? Tài khoản đăng nhập cũ (email) vẫn tồn tại nhưng sẽ không vào được app nữa vì mất hồ sơ/gán điểm bán. Các phiếu chấm công/nhập kho cũ của nhân viên này vẫn được giữ nguyên. Không thể hoàn tác.`)) return;
      try {
        await deleteDoc(doc(db, "users", uid));
        if (editingStaffUid === uid) resetStaffForm();
        toast("Đã xoá hồ sơ nhân viên");
        await loadStaffDirectory();
        renderStaffList();
        populateStaffLocationSelect();
      } catch (err) { reportError(err, "Không xoá được: " + (err.message || "")); }
    });
  });
}

// Event delegation cho sửa/ngừng hoạt động/xoá điểm bán trong view-root
// (view-root tồn tại xuyên suốt các lần render — đăng ký 1 lần duy nhất ở
// đây, không đăng ký lại mỗi lần renderQuanLy()). Các nút của Nhân sự (sửa,
// gửi lại email, vô hiệu hoá, xoá) đã được gắn riêng ngay trong
// renderStaffList() ở trên, không cần lặp lại ở đây.
viewRoot.addEventListener("click", async (e) => {
  const locEditBtn = e.target.closest("[data-loc-edit]");
  const locToggleBtn = e.target.closest("[data-loc-toggle]");
  const locDelBtn = e.target.closest("[data-loc-del]");
  if (locDelBtn) {
    const id = locDelBtn.dataset.locDel;
    const l = state.locationsDirectory[id];
    if (!confirm(`Xoá điểm bán "${l?.name || ""}"? Chỉ nên xoá nếu điểm này chưa có phiếu chấm công / dữ liệu nào gắn vào.`)) return;
    try {
      await deleteDoc(doc(db, "locations", id));
      toast("Đã xoá điểm bán");
      await loadLocationsDirectory();
      renderLocationList();
      populateStaffLocationSelect();
    } catch (err) { reportError(err, "Không xoá được: " + (err.message || "")); }
  }
  if (locEditBtn) {
    const id = locEditBtn.dataset.locEdit;
    const l = state.locationsDirectory[id];
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
    const l = state.locationsDirectory[id];
    try {
      await updateDoc(doc(db, "locations", id), { active: !(l.active !== false) });
      toast("Đã cập nhật trạng thái điểm");
      await loadLocationsDirectory();
      renderLocationList();
    } catch (err) { reportError(err, "Không cập nhật được"); }
  }
});
