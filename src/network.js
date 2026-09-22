// Banner báo mất mạng / có mạng lại — độc lập với các màn hình, chỉ cần
// import 1 lần (từ app.js) để đăng ký sự kiện.
import { toast } from "./ui.js";

export function updateNetworkBanner() {
  const el = document.getElementById("network-banner");
  if (!el) return;
  el.hidden = navigator.onLine;
}

window.addEventListener("online", () => { updateNetworkBanner(); toast("Đã có mạng lại — dữ liệu đang tự đồng bộ."); });
window.addEventListener("offline", () => { updateNetworkBanner(); toast("Mất mạng — vẫn thao tác bình thường, dữ liệu sẽ tự đồng bộ khi có mạng lại."); });
