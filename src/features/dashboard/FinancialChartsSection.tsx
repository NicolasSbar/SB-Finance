/**
 * Sección de 3 gráficos responsivos con Recharts (`FinancialChartsSection`).
 *
 * Arquitectura y decisiones técnicas:
 * - Todos los gráficos respetan estrictamente la paleta Amarillo/Negro y los colores
 *   semánticos verde (`#22C55E`) y rojo (`#EF4444`), sin violetas ni gradientes decorativos.
 * - Utilizan `<ResponsiveContainer>` sobre contenedores de altura explícita (`260px`)
 *   para renderizar limpiamente en `1440px`, `1024px`, `768px` y `390px`.
 * - Diseño adaptable: exporta `CategoryBreakdownChartCard` de forma independiente
 *   y soporta `showCategoryDonut={false}` para que `DashboardPage` pueda emparejar
 *   `CategoryLimitsWidget` con el gráfico de dona en `lg:grid-cols-2` manteniendo
 *   `Balance del Mes` y `Evolución 6 meses` a ancho completo sin huecos.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatCurrency, formatPercent } from '../../lib/formatters';
import type {
  CategoryBreakdownItem,
  MonthlyEvolutionPoint,
  MonthlyFinancialSummary,
} from '../../types/database.types';

export interface CategoryBreakdownChartCardProps {
  categoryBreakdown: CategoryBreakdownItem[];
  currency: string;
}

export interface FinancialChartsSectionProps {
  summary: MonthlyFinancialSummary;
  categoryBreakdown: CategoryBreakdownItem[];
  evolution: MonthlyEvolutionPoint[];
  currency: string;
  showCategoryDonut?: boolean;
}

function formatAxisCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(value);
}

const TOOLTIP_CONTENT_STYLE = {
  backgroundColor: '#121212',
  border: '1px solid #363636',
  borderRadius: '6px',
  color: '#FAFAFA',
  fontSize: '13px',
};

const TOOLTIP_LABEL_STYLE = {
  color: '#FACC15',
  fontWeight: 700,
  marginBottom: '4px',
};

export function CategoryBreakdownChartCard({
  categoryBreakdown,
  currency,
}: CategoryBreakdownChartCardProps) {
  return (
    <Card padding="md" className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-bold text-[#FAFAFA]">
          Gastos por Categoría
        </h2>
        <p className="text-sm text-[#A3A3A3]">
          Incluye compromisos mensuales (fijos y cuotas) más gastos variables.
        </p>
      </div>

      {categoryBreakdown.length === 0 ? (
        <EmptyState
          title="Sin gastos registrados este mes"
          description="Cargá un gasto variable, gasto fijo o cuota para visualizar cómo se distribuye tu dinero por categoría."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="h-[240px] w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={categoryBreakdown}
                  dataKey="amount"
                  nameKey="categoryName"
                  cx="50%"
                  cy="50%"
                  innerRadius={56}
                  outerRadius={88}
                  paddingAngle={2}
                  stroke="#0A0A0A"
                  strokeWidth={2}
                >
                  {categoryBreakdown.map((entry) => (
                    <Cell key={entry.categoryId} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  itemStyle={{ color: '#FAFAFA' }}
                  formatter={(value) => formatCurrency(Number(value ?? 0), currency)}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-[#1F1F1F]">
            {categoryBreakdown.map((item) => (
              <div
                key={item.categoryId}
                className="flex items-center justify-between gap-2 text-[13px]"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 rounded-xs shrink-0"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="text-[#D4D4D4] truncate">
                    {item.categoryName}
                  </span>
                </div>
                <span className="font-mono-num text-[#FAFAFA] font-medium shrink-0">
                  {formatPercent(item.percentage)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

export function FinancialChartsSection({
  summary,
  categoryBreakdown,
  evolution,
  currency,
  showCategoryDonut = true,
}: FinancialChartsSectionProps) {
  const balanceData = [
    {
      name: 'Ingresos',
      amount: summary.totalIncome,
      fill: '#22C55E',
    },
    {
      name: 'Fijos y Cuotas',
      amount: summary.totalCommitted,
      fill: '#FACC15',
    },
    {
      name: 'Ahorro Mes',
      amount: summary.totalMonthlySavings,
      fill: '#EAB308',
    },
    {
      name: 'Variables',
      amount: summary.variableExpensesTotal,
      fill: '#EF4444',
    },
    {
      name: 'Disponible',
      amount: summary.realAvailable,
      fill: summary.realAvailable >= 0 ? '#22C55E' : '#EF4444',
    },
  ];

  const hasMonthlyBalanceActivity =
    summary.totalIncome > 0 ||
    summary.totalCommitted > 0 ||
    summary.totalMonthlySavings > 0 ||
    summary.variableExpensesTotal > 0;

  const hasEvolutionActivity = evolution.some(
    (point) => point.totalIncome > 0 || point.totalExpenses > 0,
  );

  return (
    <section
      aria-label="Gráficos financieros del período"
      className={
        showCategoryDonut
          ? 'grid grid-cols-1 lg:grid-cols-2 gap-4'
          : 'flex flex-col gap-4'
      }
    >
      {/* Gráfico 1: Distribución de gastos por categoría (Dona) */}
      {showCategoryDonut ? (
        <CategoryBreakdownChartCard
          categoryBreakdown={categoryBreakdown}
          currency={currency}
        />
      ) : null}

      {/* Gráfico 2: Balance del Mes (Barras) */}
      <Card padding="md" className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-bold text-[#FAFAFA]">Balance del Mes</h2>
          <p className="text-sm text-[#A3A3A3]">
            Comparativa entre ingresos totales, apartados, gastos diarios y Disponible Real.
          </p>
        </div>

        {!hasMonthlyBalanceActivity ? (
          <EmptyState
            title="Sin datos para graficar el balance"
            description="Configurá tu sueldo fijo o registrá un movimiento para ver el balance mensual."
          />
        ) : (
          <div className="h-[260px] w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={balanceData}
                margin={{ top: 10, right: 12, left: 0, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#222222" vertical={false} />
                <XAxis
                  dataKey="name"
                  stroke="#A3A3A3"
                  tick={{ fill: '#A3A3A3', fontSize: 12 }}
                  axisLine={{ stroke: '#262626' }}
                  tickLine={false}
                />
                <YAxis
                  stroke="#A3A3A3"
                  tick={{ fill: '#A3A3A3', fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={formatAxisCompact}
                  width={48}
                />
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                  itemStyle={{ color: '#FAFAFA' }}
                  cursor={{ fill: 'rgba(250, 204, 21, 0.08)' }}
                  formatter={(value) => [
                    formatCurrency(Number(value ?? 0), currency),
                    'Monto',
                  ]}
                />
                <Bar dataKey="amount" radius={[4, 4, 0, 0]} maxBarSize={56}>
                  {balanceData.map((entry) => (
                    <Cell key={entry.name} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Gráfico 3: Evolución últimos 6 meses */}
      <Card padding="md" className="lg:col-span-2 flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-bold text-[#FAFAFA]">
            Evolución de los últimos 6 meses
          </h2>
          <p className="text-sm text-[#A3A3A3]">
            Comparativa mensual entre ingresos totales y egresos totales (fijos + cuotas + variables).
          </p>
        </div>

        {!hasEvolutionActivity ? (
          <EmptyState
            title="Todavía no hay historial suficiente"
            description="A medida que cierres meses o registres movimientos, verás la evolución comparativa de 6 meses."
          />
        ) : (
          <div className="h-[280px] w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={evolution}
                margin={{ top: 10, right: 12, left: 0, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#222222" vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke="#A3A3A3"
                  tick={{ fill: '#A3A3A3', fontSize: 12 }}
                  axisLine={{ stroke: '#262626' }}
                  tickLine={false}
                />
                <YAxis
                  stroke="#A3A3A3"
                  tick={{ fill: '#A3A3A3', fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={formatAxisCompact}
                  width={48}
                />
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                  cursor={{ fill: 'rgba(250, 204, 21, 0.08)' }}
                  formatter={(value, name) => [
                    formatCurrency(Number(value ?? 0), currency),
                    name === 'totalIncome' ? 'Ingresos' : 'Egresos Totales',
                  ]}
                />
                <Legend
                  wrapperStyle={{ fontSize: '13px', paddingTop: '8px' }}
                  formatter={(value) =>
                    value === 'totalIncome' ? 'Ingresos' : 'Egresos Totales'
                  }
                />
                <Bar
                  dataKey="totalIncome"
                  name="totalIncome"
                  fill="#22C55E"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={36}
                />
                <Bar
                  dataKey="totalExpenses"
                  name="totalExpenses"
                  fill="#FACC15"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={36}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </section>
  );
}
