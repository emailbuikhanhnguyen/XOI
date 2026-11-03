import { describe, it, expect } from "vitest";
import { dailySales, entryChannel, payrollEntry, hasPayroll, salesQuantity } from "./calc.js";

const locations = {
  shop: { type: "point", salesChannel: "retail" },
  agent: { type: "point", salesChannel: "reseller" },
  bulk: { type: "point", salesChannel: "wholesale" },
  kitchen: { type: "kitchen" },
  old: { type: "point", name: "Sỉ", giaBan: 6500 },
};
const row = (locationId, soLuong, extra = {}) => ({ locationId, date: "2026-11-03", soLuong, luong: 60000, thuong: 10000, tong: 70000, ...extra });

describe("Kênh bán và lương", () => {
  it.each(["agent", "bulk"])("%s không tính lương/thưởng nhưng giữ số lượng, không sửa dữ liệu gốc", (id) => {
    const original = row(id, 100);
    expect(payrollEntry(original, locations)).toMatchObject({ luong: 0, thuong: 0, tong: 0, soLuong: 100 });
    expect(original.tong).toBe(70000);
    expect(hasPayroll(original, locations)).toBe(false);
    expect(salesQuantity(original, locations)).toBe(100);
  });
  it("giữ lương bán lẻ và bếp; ngày nghỉ bằng 0", () => {
    expect(payrollEntry(row("shop", 30), locations).tong).toBe(70000);
    expect(payrollEntry(row("kitchen", 500), locations).tong).toBe(70000);
    expect(payrollEntry(row("shop", 30, { offDay: true }), locations).tong).toBe(0);
  });
  it("ưu tiên kênh đã lưu, kể cả điểm bị đổi loại hoặc xóa", () => {
    expect(entryChannel(row("bulk", 30, { salesChannel: "retail" }), locations)).toBe("retail");
    expect(payrollEntry(row("deleted", 30, { salesChannel: "wholesale" }), locations).tong).toBe(0);
    expect(salesQuantity(row("kitchen", 30, { salesChannel: "retail" }), locations)).toBe(30);
  });
  it("không đoán điểm cũ theo tên/giá, vẫn giữ lương cũ khi chưa phân loại", () => {
    expect(entryChannel(row("old", 30), locations)).toBe("unknown");
    expect(payrollEntry(row("old", 30), locations).tong).toBe(70000);
  });
});

describe("Tổng xôi theo ngày", () => {
  const entries = [row("shop", 100), row("agent", 200), row("bulk", 300), row("kitchen", 600), row("old", 10), row("shop", 999, { offDay: true }), row("shop", 999, { date: "2026-11-01" })];
  it("cộng ba kênh và phần chưa phân loại, loại bếp/nghỉ/ngoài khoảng; hiện ngày trống", () => {
    const days = dailySales(entries, locations, "2026-11-02", "2026-11-03");
    expect(days[0].total).toBe(0);
    expect(days[1]).toEqual({ date: "2026-11-03", retail: 100, reseller: 200, wholesale: 300, unknown: 10, total: 610 });
  });
  it("lọc theo điểm và không bỏ ngày chủ nhật hay cắt ở 62 ngày", () => {
    expect(dailySales(entries, locations, "2026-11-03", "2026-11-03", "agent")[0].total).toBe(200);
    expect(dailySales([], locations, "2026-09-01", "2026-11-03")).toHaveLength(64);
  });
  it("khoảng đảo hoặc thiếu ngày trả rỗng", () => {
    expect(dailySales(entries, locations, "2026-11-03", "2026-11-02")).toEqual([]);
    expect(dailySales(entries, locations, "", "2026-11-02")).toEqual([]);
  });
});
