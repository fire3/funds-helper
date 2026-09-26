import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Badge, ErrorState, SectionCard, Spinner } from '../../components/ui.tsx';
import { api, apiErrorDetail, apiErrorMessage } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';

/**
 * 设置页三块：模型配置 / 提示词编辑 / 用量。
 *
 * 关键约束的界面落点：
 * - **apiKey 永远不回显**（服务端只下发 `hasApiKey`），留空 = 不改；
 * - 改完**不重启进程**（服务端每次现读 `app_setting`）；
 * - 「测试连接」是刚需 —— 不测就只能等第二天早上 08:30 才知道配错了；
 * - 今日用量与限额并排显示，让用户随时知道还能调几次。
 */

interface FormState {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: string;
  maxTokens: string;
  timeoutMs: string;
  maxInputTokens: string;
  dailyLimit: string;
  enabled: boolean;
}

const VARIABLE_HINT = `可用变量：{{date}}（2026-09-25（周四））、{{window_label}}、{{item_count}}、
{{source_count}}、{{items}}（编号条目清单）、{{extra}}（界面填的额外要求）、{{output_language}}`;

function number(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function NewsSettingsPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['news', 'config'],
    queryFn: () => api.getNewsConfig(),
    staleTime: 30_000,
  });
  const historyQuery = useQuery({
    queryKey: ['news', 'history', 'today'],
    queryFn: () => api.getNewsSummaryHistory('today'),
    staleTime: 60_000,
  });

  const [form, setForm] = useState<FormState | null>(null);
  const [promptKey, setPromptKey] = useState('daily');
  const [promptForm, setPromptForm] = useState<{
    name: string;
    systemPrompt: string;
    userTemplate: string;
  } | null>(null);

  const prompts = useMemo(() => query.data?.prompts ?? [], [query.data]);
  const activePrompt = prompts.find((prompt) => prompt.key === promptKey) ?? prompts[0];

  // 服务端数据到达 / 切换模板时同步表单（之后以表单为准，避免打字被远端数据冲掉）
  useEffect(() => {
    if (form === null && query.data) {
      const { ai } = query.data;
      setForm({
        baseUrl: ai.baseUrl,
        apiKey: '',
        model: ai.model,
        temperature: String(ai.temperature),
        maxTokens: String(ai.maxTokens),
        timeoutMs: String(ai.timeoutMs),
        maxInputTokens: String(ai.maxInputTokens),
        dailyLimit: String(ai.dailyLimit),
        enabled: ai.enabled,
      });
    }
  }, [form, query.data]);

  useEffect(() => {
    if (activePrompt === undefined) return;
    setPromptForm({
      name: activePrompt.name,
      systemPrompt: activePrompt.systemPrompt,
      userTemplate: activePrompt.userTemplate,
    });
  }, [activePrompt]);

  const save = useMutation({
    mutationFn: () => {
      if (form === null) throw new Error('表单尚未加载');
      return api.updateNewsConfig({
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey,
        model: form.model.trim(),
        temperature: number(form.temperature, 0.3),
        maxTokens: number(form.maxTokens, 4000),
        timeoutMs: number(form.timeoutMs, 120_000),
        maxInputTokens: number(form.maxInputTokens, 60_000),
        dailyLimit: number(form.dailyLimit, 10),
        enabled: form.enabled,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['news', 'config'] }),
  });

  const test = useMutation({
    mutationFn: () => api.testNewsConfig(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['news'] }),
  });

  const savePrompt = useMutation({
    mutationFn: () => {
      if (promptForm === null || activePrompt === undefined) throw new Error('模板尚未加载');
      return api.updateNewsPrompt(activePrompt.key, promptForm);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['news', 'config'] }),
  });

  if (query.isPending) return <Spinner label="加载配置…" />;
  if (query.isError) {
    return (
      <ErrorState
        message={apiErrorMessage(query.error) ?? '配置加载失败'}
        detail={apiErrorDetail(query.error)}
      />
    );
  }

  const config = query.data;
  const usage = config.usage;
  const lastCall = historyQuery.data?.history.find((row) => row.status === 'success');

  return (
    <div className="space-y-4">
      {/* ---------------- 模型配置 ---------------- */}
      <SectionCard
        title="模型配置"
        subtitle="OpenAI 兼容端点；改完立即生效，无需重启进程"
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => test.mutate()}
              disabled={test.isPending}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {test.isPending ? '测试中…' : '测试连接'}
            </button>
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending || form === null}
              className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              {save.isPending ? '保存中…' : '保存'}
            </button>
          </div>
        }
      >
        {form === null ? (
          <Spinner label="加载表单…" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="baseUrl" hint="https://api.example.com/v1（自动补 /chat/completions）">
              <input
                value={form.baseUrl}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                placeholder="https://api.deepseek.com/v1"
                className={inputClass}
              />
            </Field>
            <Field
              label="model"
              hint={config.ai.hasApiKey ? '已配置 API Key（不回显）' : '未配置 API Key'}
            >
              <input
                value={form.model}
                onChange={(event) => setForm({ ...form, model: event.target.value })}
                placeholder="deepseek-chat"
                className={inputClass}
              />
            </Field>
            <Field label="apiKey" hint="留空 = 保持不变；本地 Ollama 可不填">
              <input
                type="password"
                value={form.apiKey}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                placeholder={config.ai.hasApiKey ? '••••••••（已配置）' : '未配置'}
                autoComplete="off"
                className={inputClass}
              />
            </Field>
            <Field label="temperature" hint="总结要稳，不要创造性（0–2，默认 0.3）">
              <input
                value={form.temperature}
                onChange={(event) => setForm({ ...form, temperature: event.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="max_tokens" hint="单次输出上限（256–32000）">
              <input
                value={form.maxTokens}
                onChange={(event) => setForm({ ...form, maxTokens: event.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="timeoutMs" hint="默认 120 秒；超时**不重试**（重试会放大成本）">
              <input
                value={form.timeoutMs}
                onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="maxInputTokens" hint="输入预算上限，实际目标取 0.6（留 40% 余量）">
              <input
                value={form.maxInputTokens}
                onChange={(event) => setForm({ ...form, maxInputTokens: event.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="dailyLimit" hint="每天最多调用几次（含测试连接），硬上限 1–100">
              <input
                value={form.dailyLimit}
                onChange={(event) => setForm({ ...form, dailyLimit: event.target.value })}
                className={inputClass}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                className="size-4"
              />
              启用 AI 总结（关闭后信息流不受影响）
            </label>
          </div>
        )}

        {save.isSuccess ? (
          <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
            已保存，立即生效
          </p>
        ) : null}
        {save.isError ? (
          <div className="mt-3">
            <ErrorState message="保存失败" detail={apiErrorDetail(save.error)} />
          </div>
        ) : null}

        {test.data ? (
          test.data.ok ? (
            <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
              {test.data.message} · 模型 {test.data.model}（已计入今日额度）
            </p>
          ) : (
            <ErrorState
              message={`连接失败：${test.data.message}`}
              detail={test.data.detail ?? '（没有返回细节）'}
            />
          )
        ) : null}
      </SectionCard>

      {/* ---------------- 提示词 ---------------- */}
      <SectionCard
        title="提示词库"
        subtitle="提示词是数据不是代码：改完立即生效，生成记录里会留下 prompt_hash"
        actions={
          <button
            type="button"
            onClick={() => savePrompt.mutate()}
            disabled={savePrompt.isPending || promptForm === null}
            className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {savePrompt.isPending ? '保存中…' : '保存模板'}
          </button>
        }
      >
        <div className="mb-3 flex flex-wrap gap-1.5">
          {prompts.map((prompt) => (
            <button
              key={prompt.key}
              type="button"
              onClick={() => setPromptKey(prompt.key)}
              className={
                prompt.key === activePrompt?.key
                  ? 'rounded-full border border-sky-500 bg-sky-500 px-3 py-1 text-sm text-white'
                  : 'rounded-full border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:border-sky-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
              }
            >
              {prompt.name}
              {prompt.isDefault ? '（默认）' : ''}
            </button>
          ))}
        </div>

        {promptForm === null || activePrompt === undefined ? (
          <Spinner label="加载模板…" />
        ) : (
          <div className="space-y-3">
            <p className="rounded-md bg-slate-50 px-3 py-2 text-xs whitespace-pre-line text-slate-500 dark:bg-slate-950/50 dark:text-slate-400">
              {VARIABLE_HINT}
            </p>
            <Field label="模板名称">
              <input
                value={promptForm.name}
                onChange={(event) => setPromptForm({ ...promptForm, name: event.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="system 提示词" hint={`当前 hash：${activePrompt.promptHash ?? '--'}`}>
              <textarea
                value={promptForm.systemPrompt}
                onChange={(event) =>
                  setPromptForm({ ...promptForm, systemPrompt: event.target.value })
                }
                rows={12}
                className={`${inputClass} font-mono text-xs leading-relaxed`}
              />
            </Field>
            <Field label="user 模板" hint="渲染时变量缺失会替换成空串（不会把 {{x}} 原样发给模型）">
              <textarea
                value={promptForm.userTemplate}
                onChange={(event) =>
                  setPromptForm({ ...promptForm, userTemplate: event.target.value })
                }
                rows={8}
                className={`${inputClass} font-mono text-xs leading-relaxed`}
              />
            </Field>
          </div>
        )}

        {savePrompt.isSuccess ? (
          <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
            模板已保存；旧简报会提示「由旧提示词生成」，点「重新生成」即可对齐
          </p>
        ) : null}
        {savePrompt.isError ? (
          <div className="mt-3">
            <ErrorState message="模板保存失败" detail={apiErrorDetail(savePrompt.error)} />
          </div>
        ) : null}
      </SectionCard>

      {/* ---------------- 用量 ---------------- */}
      <SectionCard title="用量" subtitle={`统计口径：Asia/Shanghai 的自然日（${usage.date}）`}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label="今日 AI 调用"
            value={`${usage.used} / ${usage.limit}`}
            hint={
              usage.used >= usage.limit
                ? '已达上限，明日重置'
                : `还可调用 ${usage.limit - usage.used} 次`
            }
          />
          <Stat
            label="上一次调用 tokens"
            value={
              lastCall === undefined
                ? '--'
                : `${lastCall.promptTokens ?? 0} + ${lastCall.completionTokens ?? 0}`
            }
            hint={
              lastCall === undefined ? '还没有成功调用过' : formatDateTime(lastCall.generatedAt)
            }
          />
          <Stat
            label="AI 总结开关"
            value={config.ai.enabled ? '已启用' : '已关闭'}
            hint={config.ai.enabled ? '关闭后信息流不受影响' : '任务会直接跳过'}
          />
        </div>
        <p className="mt-3 text-xs text-slate-400">
          单次调用约输入 17k / 输出 2k token；按常见兼容端点定价估算，每日成本约 ¥0.5–2，
          <code>dailyLimit</code> 是硬上限。
        </p>
      </SectionCard>
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-950';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: 控件就是 children（由调用方传入，规则看不​​到）
    <label className="block space-y-1">
      <span className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        {label}
        {label === 'apiKey' ? <Badge tone="info">不回显</Badge> : null}
      </span>
      {children}
      {hint === undefined ? null : (
        <span className="block text-xs text-slate-400 dark:text-slate-500">{hint}</span>
      )}
    </label>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/40">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold">{value}</p>
      <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{hint}</p>
    </div>
  );
}
