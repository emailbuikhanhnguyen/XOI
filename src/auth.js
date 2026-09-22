/* ===================== AUTH ===================== */
import {
  onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { auth, db } from "./firebase-init.js";
import { $, $$, reportError, toast } from "./ui.js";
import { isAdmin, locationName, state } from "./state.js";
import { loadItemCatalog, loadLocationsDirectory, loadSettings, loadStaffDirectory } from "./data.js";
import { updateNetworkBanner } from "./network.js";
import { router } from "./router.js";

$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  const errEl = $("#login-error");
  errEl.hidden = true;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    // Không dùng reportError()/toast() ở đây: lỗi đăng nhập hiển thị ngay
    // dưới form (errEl) là đủ rõ ràng, thêm toast sẽ chỉ trùng lặp thông báo.
    console.error(err);
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
    reportError(err, "Không gửi được email. Kiểm tra lại email đã nhập.");
  }
});

onAuthStateChanged(auth, async (user) => {
  if (user) {
    state.currentUser = user;
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (!snap.exists()) {
        toast("Tài khoản chưa được thiết lập hồ sơ. Liên hệ chủ quán.");
        await signOut(auth);
        return;
      }
      state.profile = snap.data();
      await Promise.all([loadStaffDirectory(), loadLocationsDirectory(), loadSettings(), loadItemCatalog()]);
      showApp();
    } catch (err) {
      reportError(err, "Không thể tải hồ sơ người dùng.");
    }
  } else {
    state.currentUser = null;
    state.profile = null;
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
  const locLabel = state.profile.locationId ? " · " + locationName(state.profile.locationId) : "";
  $("#user-chip").textContent = `${state.profile.name} · ${roleLabel}${locLabel}`;
  $$(".nav-item[data-admin-only]").forEach((btn) => { btn.hidden = !isAdmin(); });
  if (!isAdmin() && !state.profile.locationId) {
    toast("Tài khoản của bạn chưa được gán điểm bán. Liên hệ chủ quán để được gán.");
  }
  if (!location.hash || (!isAdmin() && ["#/bao-cao", "#/quan-ly"].includes(location.hash))) {
    location.hash = "#/trang-chu";
  } else {
    router();
  }
}
