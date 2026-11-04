"use client";

import { Check, LoaderCircle, Send, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "../lib/use-router";
import type { AutomationConfig, AutomationDelivery } from "../lib/automation-webhook";
import {
  clearAutomationDeliveriesAction,
  clearAutomationWebhookAction,
  saveAutomationWebhookAction,
  testAutomationWebhookAction,
} from "../app/actions";
import { runAction } from "../lib/run-action";

const TASK_FIELDS: Array<{ key: keyof AutomationConfig["taskNames"]; label: string }> = [
  { key: "movies", label: "电影" },
  { key: "tv", label: "电视剧" },
  { key: "variety", label: "综艺" },
  { key: "anime", label: "动漫" },
];

function statusLabel(delivery: AutomationDelivery): string {
  if (delivery.status === "sent") {
    return `成功${delivery.httpStatus ? ` · HTTP ${delivery.httpStatus}` : ""}`;
  }
  return `失败${delivery.httpStatus ? ` · HTTP ${delivery.httpStatus}` : ""}`;
}

/**
 * SmartStrm 自动化：每次落盘后按目录触发 a_task，并做静默期去抖——同一部剧
 * 两集在同一轮里陆续落盘时只发一次扫描。URL / HMAC / 任务名 / 去抖参数都在
 * 这里配置；每个盘的挂载前缀在「网盘连接 → 媒体库目录」里单独填。
 */
export function AutomationWebhookForm({
  config,
  secretSet,
  sampleStoragePath,
  deliveries,
}: {
  config: AutomationConfig;
  secretSet: boolean;
  sampleStoragePath: string;
  deliveries: AutomationDelivery[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(config.enabled);
  const [url, setUrl] = useState(config.url);
  const [secret, setSecret] = useState("");
  const [taskNames, setTaskNames] = useState(config.taskNames);
  const [quietSeconds, setQuietSeconds] = useState(String(config.quietSeconds));
  const [maxWaitSeconds, setMaxWaitSeconds] = useState(String(config.maxWaitSeconds));
  const [retries, setRetries] = useState(String(config.retries));
  const [incremental, setIncremental] = useState(config.incremental);
  const [dirTimeCheck, setDirTimeCheck] = useState(config.dirTimeCheck);
  const [delaySeconds, setDelaySeconds] = useState(String(config.delaySeconds));
  const [result, setResult] = useState<string | null>(null);

  const note = (message: string, ms = 6000) => {
    setResult(message);
    setTimeout(() => setResult(null), ms);
  };

  const currentConfig = (): AutomationConfig => ({
    ...config,
    enabled,
    url,
    secret,
    taskNames,
    quietSeconds: Number(quietSeconds),
    maxWaitSeconds: Number(maxWaitSeconds),
    retries: Number(retries),
    incremental,
    dirTimeCheck,
    delaySeconds: Number(delaySeconds),
  });

  const save = () => {
    startTransition(async () => {
      const r = await runAction(
        () => saveAutomationWebhookAction({ config: currentConfig() }),
        (message) => note(`❌ ${message}`),
      );
      if (!r.ok) return;
      if (r.value.success) {
        setSecret("");
        note("✅ 已保存");
        router.refresh();
      } else {
        note(`❌ ${r.value.message ?? "保存失败"}`);
      }
    });
  };

  const clear = () => {
    startTransition(async () => {
      const r = await runAction(
        () => clearAutomationWebhookAction(),
        (message) => note(`❌ ${message}`),
      );
      if (!r.ok) return;
      if (r.value.success) {
        setEnabled(false);
        setUrl("");
        setSecret("");
        note("✅ 已关闭自动化 Webhook");
        router.refresh();
      } else {
        note(`❌ ${r.value.message ?? "清除失败"}`);
      }
    });
  };

  const test = () => {
    startTransition(async () => {
      const r = await runAction(
        () =>
          testAutomationWebhookAction({
            url,
            secret,
            taskName: taskNames.movies || "电影",
            storagePath: sampleStoragePath,
            config: { incremental, dirTimeCheck, delaySeconds: Number(delaySeconds) },
          }),
        (message) => note(`❌ ${message}`),
      );
      if (!r.ok) return;
      note(r.value.success ? `✅ 已发送：${r.value.message ?? ""}` : `❌ ${r.value.message ?? "发送失败"}`);
    });
  };

  const clearLog = () => {
    startTransition(async () => {
      const r = await runAction(
        () => clearAutomationDeliveriesAction(),
        (message) => note(`❌ ${message}`),
      );
      if (!r.ok) return;
      if (r.value.success) {
        note("✅ 已清空投递记录");
        router.refresh();
      }
    });
  };

  return (
    <div className="push-form">
      <label className="automation-enabled">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        落盘后自动触发 SmartStrm 扫描
      </label>
      <div className="push-field">
        <label className="push-label">Webhook 地址（SmartStrm → /webhook/&lt;token&gt;）</label>
        <input
          type="url"
          className="setting-control"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="http://smartstrm:8024/webhook/你的token"
          aria-label="自动化 Webhook 地址"
          autoComplete="off"
        />
      </div>
      <div className="push-field">
        <label className="push-label">签名密钥（可选，HMAC-SHA256）</label>
        <input
          type="password"
          className="setting-control"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder={secretSet ? "已设置（留空则保持不变）" : "接收端可校验 X-Media-Track-Signature"}
          aria-label="自动化 Webhook 签名密钥"
          autoComplete="off"
        />
      </div>
      <div className="push-field">
        <label className="push-label">SmartStrm 任务名（按媒体库分类；留空则该分类不触发）</label>
        <div className="emby-library-fields">
          {TASK_FIELDS.map((field) => (
            <label key={field.key} className="emby-library-field">
              <span>{field.label}</span>
              <input
                className="setting-control"
                value={taskNames[field.key]}
                onChange={(event) =>
                  setTaskNames((previous) => ({ ...previous, [field.key]: event.target.value }))
                }
                placeholder={field.label}
                aria-label={`${field.label} SmartStrm 任务名`}
                autoComplete="off"
              />
            </label>
          ))}
        </div>
      </div>
      <div className="automation-grid">
        <label className="push-field">
          <span className="push-label">静默期（秒）</span>
          <input
            type="number"
            min={1}
            max={3600}
            className="setting-control"
            value={quietSeconds}
            onChange={(event) => setQuietSeconds(event.target.value)}
          />
        </label>
        <label className="push-field">
          <span className="push-label">最长等待（秒）</span>
          <input
            type="number"
            min={1}
            max={7200}
            className="setting-control"
            value={maxWaitSeconds}
            onChange={(event) => setMaxWaitSeconds(event.target.value)}
          />
        </label>
        <label className="push-field">
          <span className="push-label">重试次数</span>
          <input
            type="number"
            min={0}
            max={10}
            className="setting-control"
            value={retries}
            onChange={(event) => setRetries(event.target.value)}
          />
        </label>
        <label className="push-field">
          <span className="push-label">延迟（秒）</span>
          <input
            type="number"
            min={0}
            max={3600}
            className="setting-control"
            value={delaySeconds}
            onChange={(event) => setDelaySeconds(event.target.value)}
          />
        </label>
      </div>
      <div className="automation-toggles">
        <label>
          <input type="checkbox" checked={incremental} onChange={(event) => setIncremental(event.target.checked)} />
          增量扫描（incremental）
        </label>
        <label>
          <input
            type="checkbox"
            checked={dirTimeCheck}
            onChange={(event) => setDirTimeCheck(event.target.checked)}
          />
          目录时间检查（dir_time_check）
        </label>
      </div>
      <div className="service-actions">
        <button type="button" className="primary-button" onClick={save} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
        <button type="button" className="secondary-button" onClick={test} disabled={isPending || !url.trim()}>
          <Send size={14} aria-hidden />
          发送测试
        </button>
        {enabled || url ? (
          <button type="button" className="secondary-button" onClick={clear} disabled={isPending}>
            <Trash2 size={14} aria-hidden />
            关闭
          </button>
        ) : null}
        {result ? <span className="panel-note">{result}</span> : null}
      </div>
      <p className="panel-note">
        测试会向上面的地址发送一条 a_task（路径示例：{sampleStoragePath}）。同一目录在静默期内反复落盘只发一次，
        最长等待到期后一定发送。每个盘的挂载前缀在「网盘连接 → 媒体库目录」中配置。
      </p>

      <div className="automation-log">
        <div className="automation-log-head">
          <strong>最近投递</strong>
          {deliveries.length > 0 ? (
            <button type="button" className="push-clear" onClick={clearLog} disabled={isPending}>
              清空记录
            </button>
          ) : null}
        </div>
        {deliveries.length === 0 ? (
          <p className="panel-note">还没有投递记录。</p>
        ) : (
          <ul className="automation-log-list">
            {deliveries.map((delivery) => (
              <li key={delivery.id + delivery.at} className={`automation-log-item is-${delivery.status}`}>
                <span className="automation-log-time">{new Date(delivery.at).toLocaleString("zh-CN")}</span>
                <span className="automation-log-path" title={delivery.storagePath}>
                  {delivery.taskName} · {delivery.storagePath}
                </span>
                <span className="automation-log-status" title={delivery.detail ?? undefined}>
                  {statusLabel(delivery)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
