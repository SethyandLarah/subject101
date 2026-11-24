// FIFO purchase-cost allocation. Every positive stock movement is a "lot" with a
// unit cost (null = cost unavailable) and a remaining quantity. Sales and stock-outs
// consume the oldest lots first; a void puts units back on the lots they came from.
export function createCosting(db) {
  const sql = s => db.prepare(s);
  const lots = sql('SELECT id, unit_cost, remaining FROM movements WHERE material_id=? AND remaining > 0 ORDER BY id');
  const take = sql('UPDATE movements SET remaining = remaining - ? WHERE id=?');
  const give = sql('UPDATE movements SET remaining = remaining + ? WHERE id=?');
  const record = sql('INSERT INTO sale_allocations(sale_id,material_id,lot_id,qty,unit_cost) VALUES (?,?,?,?,?)');

  /** Consume qty (thousandths) FIFO. Returns {cost|null, parts}. cost is null when any lot has no cost. */
  function consume(materialId, qty, saleId = null) {
    let left = qty, cost = 0, unknown = false; const parts = [];
    for (const lot of lots.all(materialId)) {
      if (left <= 0) break;
      const use = Math.min(lot.remaining, left);
      take.run(use, lot.id); left -= use;
      if (lot.unit_cost === null) unknown = true; else cost += Number((BigInt(use) * BigInt(lot.unit_cost) + 500n) / 1000n);
      parts.push({ lotId: lot.id, qty: use, unitCost: lot.unit_cost });
      if (saleId && lot.unit_cost !== null) record.run(saleId, materialId, lot.id, use, lot.unit_cost);
      if (saleId && lot.unit_cost === null) record.run(saleId, materialId, lot.id, use, -1); // -1 marks "cost unavailable"
    }
    if (left > 0) unknown = true; // stock existed before lots were tracked
    return { cost: unknown ? null : cost, parts };
  }
  /** Void: return every allocated unit to its original lot and drop the allocations. */
  function restore(saleId) {
    for (const a of sql('SELECT lot_id, qty FROM sale_allocations WHERE sale_id=?').all(saleId)) give.run(a.qty, a.lot_id);
    sql('DELETE FROM sale_allocations WHERE sale_id=?').run(saleId);
  }
  /** Admin enters the cost for stock that existed before costs were tracked. */
  function setOpeningCost(materialId, unitCost) {
    return sql("UPDATE movements SET unit_cost=? WHERE material_id=? AND unit_cost IS NULL AND kind IN ('Opening stock','Count adjustment','Void return') AND remaining > 0").run(unitCost, materialId).changes;
  }
  const pendingCost = materialId => sql('SELECT coalesce(sum(remaining),0) AS q FROM movements WHERE material_id=? AND unit_cost IS NULL AND remaining > 0').get(materialId).q;
  return { consume, restore, setOpeningCost, pendingCost };
}
