# 🌿 Sổ Xôi — Bếp trung tâm · Điểm bán · Lương · Nguyên liệu · Doanh thu

App web (PWA) quản lý quán xôi có **1 bếp trung tâm + nhiều điểm bán**: chấm
công/lương theo từng điểm, nguyên liệu & tồn kho ở bếp, chuyển hàng ra điểm
bán, và báo cáo doanh thu/lợi nhuận theo từng điểm lẫn toàn hệ thống.

> **Đang nâng cấp từ bản cũ?** Bản này có thêm collection Firestore mới
> (`itemCatalog`, `orders`) và cập nhật `firestore.rules` (thêm quyền cho
> chủ quán tạo phiếu chấm công hộ nhân viên). Sau khi đưa code mới lên, nhớ
> vào **Firebase Console → Firestore Database → Rules**, dán lại toàn bộ nội
> dung file `firestore.rules` mới rồi bấm **Publish** — nếu quên bước này,
> mục "Định mức nguyên liệu" ở Quản lý, mục "Đặt hàng nguyên liệu" ở điểm
> bán, và việc chủ quán tạo phiếu chấm công mới cho nhân viên khác sẽ báo
> lỗi khi lưu.

## Mô hình dữ liệu

- **Locations** (`locations`): danh sách các điểm — 1 hoặc nhiều **Bếp trung
  tâm** (`type: kitchen`) và nhiều **Điểm bán** (`type: point`). Mỗi điểm có
  giá bán/phần và lương cơ bản mặc định riêng.
- **Nhân viên**: mỗi tài khoản được **gán vào đúng 1 điểm** (`locationId`).
  Chấm công/doanh thu của nhân viên luôn gắn với điểm đó.
- **Nguyên liệu** (`ingredients`): ghi nhận nhập hàng vào bếp trung tâm (tên
  nguyên liệu tự do, đơn vị, số lượng, thành tiền).
- **Chuyển hàng** (`transfers`): bếp trung tâm ghi nhận xuất hàng cho từng
  điểm bán theo ngày. Điểm bán chỉ xem được (không sửa) danh sách đã nhận.
- **Đặt hàng nguyên liệu** (`orders`): điểm bán chủ động gửi yêu cầu nguyên
  liệu cần (tên, số lượng, ngày cần, ghi chú) cho bếp trung tâm. Bếp/chủ quán
  thấy danh sách yêu cầu đang chờ, có thể bấm "Điền vào form chuyển hàng" để
  tạo phiếu chuyển hàng tương ứng rồi đánh dấu "Đã chuyển", hoặc điểm bán tự
  huỷ đơn nếu đặt nhầm.
- **Tồn kho bếp** = tổng đã nhập − tổng đã chuyển đi (tính trong 365 ngày gần
  nhất), tính theo từng loại nguyên liệu.
- **Thu & chi** (`thuchi`): sổ ghi các khoản thu/chi ngoài lương và nguyên
  liệu (tiền mặt bằng, điện nước, sửa chữa, thu khác...), mỗi khoản có loại
  (thu/chi), danh mục, số tiền, ngày, và có thể gắn với 1 điểm bán/bếp cụ thể
  hoặc để "Chung (toàn quán)". Chỉ chủ quán mới thêm/sửa/xoá được.
- **Báo cáo**: lọc theo khoảng ngày + theo điểm bán (hoặc "Tất cả điểm"), có
  bảng so sánh từng điểm, bảng theo nhân viên, biểu đồ theo ngày, quyết toán
  lương theo tuần, xuất CSV. Lợi nhuận ước tính đã cộng/trừ thêm **Thu khác /
  Chi khác** lấy từ sổ Thu & chi trong cùng khoảng ngày (và cùng điểm bán nếu
  có lọc).

## Tính năng theo vai trò

- **Chủ quán (admin)**: thấy toàn bộ hệ thống — quản lý điểm bán/bếp, tạo tài
  khoản nhân viên và gán điểm, xem kho + chuyển hàng ở mọi bếp, ghi sổ Thu &
  chi (mục "Thu chi" trên thanh điều hướng), xem báo cáo toàn hệ thống hoặc
  từng điểm. Ở màn **Chấm công**, chủ quán có thêm ô chọn "Xem / sửa chấm
  công của" để xem, sửa, xoá hoặc tạo mới phiếu chấm công **của bất kỳ nhân
  viên nào**, không chỉ của chính mình.
- **Nhân viên tại bếp trung tâm**: chấm công như bình thường, cộng thêm quyền
  nhập nguyên liệu, ghi nhận chuyển hàng cho các điểm bán, xem tồn kho.
- **Nhân viên tại điểm bán**: chấm công (lương, số lượng bán, thưởng, ship,
  xôi ế/dẹp — giống bảng cũ), xem (không sửa) danh sách hàng đã nhận từ bếp,
  và tự gửi yêu cầu đặt hàng nguyên liệu cần cho bếp trung tâm.

## Cấu trúc file

```
index.html              Khung giao diện + toàn bộ template các màn hình
styles.css               Giao diện (tông màu lá chuối – xôi gấc – nghệ)
app.js                    Toàn bộ logic: đăng nhập, đọc/ghi dữ liệu, tính toán
firebase-config.js        Nơi bạn dán cấu hình project Firebase của mình
firestore.rules           Luật bảo mật dữ liệu (deploy lên Firebase)
manifest.webmanifest       Khai báo PWA
sw.js                      Service worker (chạy offline phần giao diện)
```

## 1. Tạo Firebase project (miễn phí)

1. Vào https://console.firebase.google.com → **Add project** → đặt tên (vd
   `so-xoi`) → tạo xong.
2. Vào **Build → Authentication → Get started** → tab **Sign-in method** →
   bật **Email/Password**.
3. Vào **Build → Firestore Database → Create database** → chọn **Production
   mode** → chọn khu vực gần Việt Nam (vd `asia-southeast1`).
4. Vào **Project settings** (biểu tượng bánh răng) → mục **Your apps** → bấm
   biểu tượng **</>** (Web) → đặt tên app → **Register app**. Firebase sẽ hiện
   một đoạn `firebaseConfig = {...}` — copy các giá trị đó.

## 2. Điền cấu hình vào project

Mở file `firebase-config.js`, dán đúng các giá trị Firebase vừa copy vào:

```js
export const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
};
```

> Đây **không phải** khoá bí mật — Firebase web config vốn công khai được,
> bảo mật thật sự nằm ở `firestore.rules`.

## 3. Deploy luật bảo mật Firestore

Mở **Firestore Database → Rules** trong Firebase Console, xoá hết nội dung
mặc định, dán toàn bộ nội dung file `firestore.rules` vào, bấm **Publish**.

## 4. Tạo tài khoản Chủ quán đầu tiên

Vì chỉ "Chủ quán" mới tạo được điểm bán và tài khoản khác trong app, tài
khoản chủ quán **đầu tiên** cần tạo thủ công một lần:

1. **Authentication → Users → Add user** → nhập email + mật khẩu cho chính bạn.
2. Copy **User UID** vừa tạo (cột UID trong danh sách).
3. **Firestore Database → Start collection** → Collection ID: `locations` →
   tạo trước ít nhất 1 tài liệu bếp trung tâm, ví dụ Document ID để tự động,
   các field:
   - `name` (string): `Bếp trung tâm`
   - `type` (string): `kitchen`
   - `giaBan` (number): giá bán mỗi phần, vd `15000`
   - `luongMacDinh` (number): lương cơ bản mặc định/ngày, vd `60000`
   - `active` (boolean): `true`
   - Ghi lại **Document ID** vừa tạo (đây chính là `locationId` của bếp).
4. Tạo tiếp collection `users` → Document ID: dán đúng UID vừa copy ở bước 1
   → thêm các field:
   - `name` (string): tên bạn, vd `Chị Hai`
   - `role` (string): `admin`
   - `email` (string): email vừa tạo
   - `locationId` (string): Document ID của bếp trung tâm ở bước 3
   - `active` (boolean): `true`
5. Lưu lại. Giờ bạn có thể đăng nhập vào app bằng email/mật khẩu này với vai
   trò Chủ quán. Vào mục **Quản lý** để thêm các điểm bán còn lại và tạo tài
   khoản cho nhân viên (mục này tự gán `locationId` cho bạn, không cần thao
   tác thủ công trên Firestore nữa từ đây trở đi).

## 5. Đưa lên GitHub và bật GitHub Pages

```bash
git init
git add .
git commit -m "Sổ Xôi - bếp trung tâm & điểm bán"
git branch -M main
git remote add origin https://github.com/<tên-bạn>/<tên-repo>.git
git push -u origin main
```

Sau đó vào repo trên GitHub → **Settings → Pages** → mục **Source** chọn
nhánh `main`, thư mục `/ (root)` → **Save**. Sau 1–2 phút, app sẽ chạy tại:

```
https://<tên-bạn>.github.io/<tên-repo>/
```

Mở link đó trên điện thoại → trình duyệt sẽ gợi ý **"Thêm vào Màn hình
chính"** để dùng như một app thật.

## 6. Ghi chú vận hành

- **Thưởng** không tự tính, bạn nhập tay và ghi chú lý do — giống cách làm
  trong sheet cũ.
- **Doanh thu ước tính** = Số lượng bán × Giá bán mỗi phần của **điểm bán đó**
  (đặt riêng cho từng điểm ở mục Quản lý → Điểm bán). Đây là ước tính, không
  thay cho sổ thu tiền thực tế.
- **Chi phí nguyên liệu** phát sinh chung ở bếp trung tâm nên báo cáo không
  tự chia đều cho từng điểm bán — xem tổng chi phí NL ở lựa chọn "Tất cả
  điểm" hoặc chọn đúng bếp.
- **Tồn kho** tính trên cửa sổ 365 ngày gần nhất (nhập − đã chuyển đi). Ở màn
  Kho (bếp/admin), bấm **"Kiểm kê kho"** cạnh bảng Tồn kho hiện tại để nhập
  tồn kho ban đầu hoặc đối chiếu định kỳ: nhập số đếm thực tế cho từng
  nguyên liệu, hệ thống tự tính chênh lệch và ghi 1 dòng "nhập nguyên liệu"
  điều chỉnh (âm hoặc dương) — không cần tính tay.
- Đổi tên/giá bán/lương mặc định của 1 điểm ở mục Quản lý sẽ áp dụng cho các
  phiếu **mới** từ lúc đó; phiếu cũ đã lưu không bị tính lại.

## Nâng cấp về sau (tuỳ chọn)

- Thêm Cloud Functions để chủ quán tạo tài khoản nhân viên mà không cần mật
  khẩu tạm (gửi link mời qua email).
- Thêm biểu đồ lợi nhuận theo tháng, xuất báo cáo PDF.
- Phân bổ chi phí nguyên liệu về từng điểm bán theo tỷ lệ số lượng bán, nếu
  cần độ chính xác lợi nhuận theo điểm cao hơn.
- Thêm bước kiểm kho định kỳ có ghi log điều chỉnh riêng (thay vì chỉ dựa vào
  nhập − xuất).
