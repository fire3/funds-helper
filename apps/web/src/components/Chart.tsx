import { BarChart, LineChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import { useIsDark } from '../lib/theme.ts';

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

const PALETTE = { dark: '#e2e8f0', light: '#334155' };
const GRID_LINE = { dark: '#1e293b', light: '#e2e8f0' };

interface Series {
  name: string;
  data: (number | null)[];
  type?: 'line' | 'bar';
  area?: boolean;
}

/** 走势图上的事件标注（如「份额分拆」），按 x 轴类目值定位 */
export interface MarkLine {
  axis: string;
  label: string;
}

/** 折线/柱状图封装。按需引入 echarts 模块，避免打包整个 echarts */
export function Chart({
  categories,
  series,
  height = 260,
  yFormatter,
  tooltipFormatter,
  markLines,
}: {
  categories: string[];
  series: Series[];
  height?: number;
  yFormatter?: (value: number) => string;
  tooltipFormatter?: (params: unknown[]) => string;
  /** 仅画在第一条序列上（净值走势用它标出份额分拆 / 分红除息的日期）*/
  markLines?: MarkLine[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const dark = useIsDark();

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const chart = echarts.init(element);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    chart.setOption(
      {
        backgroundColor: 'transparent',
        grid: { left: 8, right: 12, top: 24, bottom: 8, containLabel: true },
        tooltip: {
          trigger: 'axis',
          ...(tooltipFormatter ? { formatter: tooltipFormatter } : {}),
        },
        legend:
          series.length > 1
            ? { top: 0, right: 0, textStyle: { color: dark ? PALETTE.dark : PALETTE.light } }
            : undefined,
        xAxis: {
          type: 'category',
          data: categories,
          boundaryGap: series.some((item) => item.type === 'bar'),
          axisLine: { lineStyle: { color: dark ? GRID_LINE.dark : GRID_LINE.light } },
          axisLabel: { color: dark ? PALETTE.dark : PALETTE.light, hideOverlap: true },
        },
        yAxis: {
          type: 'value',
          scale: true,
          splitLine: { lineStyle: { color: dark ? GRID_LINE.dark : GRID_LINE.light } },
          axisLabel: {
            color: dark ? PALETTE.dark : PALETTE.light,
            ...(yFormatter ? { formatter: yFormatter } : {}),
          },
        },
        series: series.map((item, index) => ({
          name: item.name,
          type: item.type ?? 'line',
          data: item.data,
          showSymbol: false,
          smooth: false,
          ...(item.area
            ? { areaStyle: { opacity: 0.12 }, lineStyle: { width: 1.5 } }
            : { lineStyle: { width: 1.5 } }),
          ...(index === 0 && markLines && markLines.length > 0
            ? {
                markLine: {
                  symbol: ['none', 'none'],
                  lineStyle: { type: 'dashed', color: dark ? '#fbbf24' : '#d97706' },
                  label: {
                    formatter: '{b}',
                    position: 'insideEndTop',
                    color: dark ? '#fbbf24' : '#b45309',
                    fontSize: 10,
                  },
                  data: markLines.map((line) => ({ xAxis: line.axis, name: line.label })),
                },
              }
            : {}),
        })),
      },
      true,
    );
  }, [categories, series, dark, yFormatter, tooltipFormatter, markLines]);

  return <div ref={containerRef} style={{ height }} className="w-full" />;
}
