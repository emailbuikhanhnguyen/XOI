/* ===================== ROUTER ===================== */
import { $, $$, toast } from "./ui.js";
import { isAdmin, state } from "./state.js";
import { renderTrangChu } from "./screens/trang-chu.js";
import { renderChamCong } from "./screens/cham-cong.js";
import { renderKho } from "./screens/kho.js";
import { renderThuChi } from "./screens/thu-chi.js";
import { renderBaoCao } from "./screens/bao-cao.js";
import { renderQuanLy } from "./screens/quan-ly.js";

const ADMIN_ONLY = ["bao-cao", "quan-ly", "thu-chi"];
const TITLES = {
  "trang-chu": "Trang chủ", "cham-cong": "Chấm công", "kho": "Kho & Chuyển hàng",
  "thu-chi": "Thu & chi", "bao-cao": "Báo cáo", "quan-ly": "Quản lý",
};

window.addEventListener("hashchange", router);
$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => { location.hash = "#/" + btn.dataset.view; });
});

export function router() {
  if (!state.profile) return;
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
