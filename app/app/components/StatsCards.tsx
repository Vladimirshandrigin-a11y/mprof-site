type Props = {
  totalRevenue: number
  totalProfit: number
  avgMargin: number
  historyCount: number
}

export function StatsCards({
  totalRevenue,
  totalProfit,
  avgMargin,
  historyCount,
}: Props) {
  return (
    <div className="stats-grid">
      <div className="stat-card">
        <div className="stat-label">Общая выручка</div>
        <div className="stat-value">{totalRevenue} ₽</div>
      </div>

    <div className="stat-card">
  <div className="stat-label">Общая прибыль</div>

  <div
    className={
      "stat-value " + (totalProfit >= 0 ? "pos" : "neg")
    }
  >
    {totalProfit >= 0 ? "+" : "-"}
    {Math.abs(totalProfit)} ₽
  </div>
</div>

      <div className="stat-card">
        <div className="stat-label">Средняя маржа</div>
        <div className="stat-value">{avgMargin.toFixed(1)}%</div>
      </div>

      <div className="stat-card">
        <div className="stat-label">Всего расчётов</div>
        <div className="stat-value">{historyCount}</div>
      </div>
    </div>
  )
}