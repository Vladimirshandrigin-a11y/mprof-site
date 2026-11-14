import assert from "node:assert/strict";
import { it } from "node:test";
import { legacyUpd } from "./helpers/modules.mjs";
const rows = [{ article: "A", name: "Товар", revenue: 1000, returnsAmount: 0, loyaltyPayout: 0, quantity: 2,
  matched: true, unitCost: 100, cogs: 200, profit: 600, margin: 60, hasCost: true }];
const totals = { cost: 200, profit: 600, revenue: 1000 };
it("UPD: saved financial detail stays exact without any current catalog", () => {
  const saved = { kind: "net-profit-3file", productBreakdownRows: rows };
  const before = JSON.stringify(saved);
  const detail = legacyUpd.readLegacyUpdProductDetail(saved,totals);
  assert.deepEqual(detail,rows);
  const catalog = [{ sku: "A", cost_price: 900 }]; catalog[0].cost_price = 2000;
  assert.deepEqual(legacyUpd.readLegacyUpdProductDetail(saved,totals),detail);
  assert.equal(JSON.stringify(saved),before);
});
it("UPD: raw product rows contain no historical cost and must not become financial detail", () => {
  for (const saved of [null, {kind:"net-profit-3file"}, {kind:"net-profit-3file",products:[{article:"A",name:"Товар",revenue:1000,quantity:2}]}]) {
    assert.equal(legacyUpd.readLegacyUpdProductDetail(saved,totals),null);
  }
  assert.match(legacyUpd.LEGACY_DETAIL_UNAVAILABLE,/Общий финансовый итог сохранён/);
});
it("UPD: persisted enriched product rows are supported; mismatched or damaged rows fail closed", () => {
  assert.deepEqual(legacyUpd.readLegacyUpdProductDetail({kind:"net-profit-3file",products:rows},totals),rows);
  for (const patch of [{cogs:999}, {profit:500}, {unitCost:null}, {margin:NaN}, {hasCost:false}]) {
    assert.equal(legacyUpd.readLegacyUpdProductDetail({kind:"net-profit-3file",productBreakdownRows:[{...rows[0],...patch}]},totals),null);
  }
});
