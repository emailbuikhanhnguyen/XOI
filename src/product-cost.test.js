import { describe, it, expect } from "vitest";
import { manualProductCost, manualProductCosts, productCostForSales } from "./calc.js";

describe("Giá vốn nhập tay", () => {
  it("nhận mức giá hợp lệ và giá 0", () => {
    expect(manualProductCost({ giaVonMoiVien: 4000 })).toBe(4000);
    expect(manualProductCost({ giaVonMoiVien: 0 })).toBe(0);
  });
  it("để trống, thiếu hoặc sai kiểu dùng định mức cũ", () => {
    for (const value of [null, undefined, "", "4000", -1, NaN, Infinity]) {
      expect(manualProductCost({ giaVonMoiVien: value })).toBeNull();
    }
  });
});

describe("Giá vốn theo kênh", () => {
  const prices = { retail: 4000, wholesale: 3500 };
  const locations = {
    le: { salesChannel: "retail" },
    moi: { salesChannel: "reseller" },
    si: { salesChannel: "wholesale" },
    bep: { type: "kitchen" },
  };

  it("giữ giá chung cũ cho cả hai nhóm tới khi lưu hai mức riêng", () => {
    expect(manualProductCosts({ giaVonMoiVien: 3900 })).toEqual({ retail: 3900, wholesale: 3900 });
    expect(manualProductCosts({ giaVonMoiVien: 3900, giaVonTheoKenh: { retail: 0, wholesale: 3500 } }))
      .toEqual({ retail: 0, wholesale: 3500 });
    expect(manualProductCosts({ giaVonTheoKenh: null, giaVonMoiVien: null })).toBeNull();
    expect(manualProductCosts({ giaVonTheoKenh: { retail: 4000, wholesale: null } })).toBeNull();
  });

  it("dùng chung giá sỉ và bỏ mối, ưu tiên kênh đã lưu trên phiếu", () => {
    const entries = [
      { locationId: "le", soLuong: 10 },
      { locationId: "moi", soLuong: 20 },
      { locationId: "le", salesChannel: "wholesale", soLuong: 100 },
      { locationId: "bep", soLuong: 1000 },
      { locationId: "si", soLuong: 1000, offDay: true },
    ];
    expect(productCostForSales(entries, locations, prices)).toBe(460000);
  });

  it("báo thiếu kênh khi có hai giá khác nhau, kể cả khi một mức giá bằng 0", () => {
    const entries = [{ locationId: "cu", soLuong: 10 }];
    expect(productCostForSales(entries, locations, { retail: 0, wholesale: 3500 })).toBeNull();
    expect(productCostForSales(entries, locations, { retail: 4000, wholesale: 4000 })).toBe(40000);
    expect(productCostForSales([{ locationId: "cu", soLuong: 0 }], locations, prices)).toBe(0);
  });
});
