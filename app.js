// Điểm khởi động (composition root) của app — CHỈ lo đăng ký service worker
// và import các module còn lại để chúng tự đăng ký sự kiện của mình (mỗi
// module import 1 lần, ES module chỉ thực thi 1 lần dù được import từ nhiều
// nơi). Toàn bộ logic thực sự nằm trong src/ — xem README.md mục "Cấu trúc
// mã nguồn (đã module hoá)" để biết module nào lo màn hình nào.
import "./src/network.js";
import "./src/ui.js";
import "./src/auth.js";
import "./src/router.js";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
