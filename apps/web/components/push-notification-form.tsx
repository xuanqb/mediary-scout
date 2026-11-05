"use client";

import { useState, useTransition } from "react";
import { Bell, ExternalLink, LoaderCircle, Trash2 } from "lucide-react";
import {
  clearPushChannelAction,
  savePushSettingsAction,
  testPushNotificationAction,
} from "../app/actions";
import { runAction } from "../lib/run-action";

const WECOM_PLACEHOLDER = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...";

/** Single push channel: a WeCom group robot. Saved keys are never echoed back —
 *  the input starts empty and only changes when the user types a replacement. */
export function PushNotificationForm({ configured }: { configured: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(configured);
  const [testResult, setTestResult] = useState<string | null>(null);

  const note = (message: string, ms = 3000) => {
    setTestResult(message);
    setTimeout(() => setTestResult(null), ms);
  };

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () => savePushSettingsAction({ wecom: value }),
        (msg) => note(`❌ ${msg}`),
      );
      if (!r.ok) return;
      if (r.value.success) {
        if (value.trim()) setSaved(true);
        setValue("");
      }
      note(r.value.success ? "✅ 保存成功" : `❌ ${r.value.message}`);
    });
  };

  const handleClear = () => {
    startTransition(async () => {
      const r = await runAction(
        () => clearPushChannelAction("wecom"),
        (msg) => note(`❌ ${msg}`),
      );
      if (!r.ok) return;
      if (r.value.success) {
        setSaved(false);
        setValue("");
      }
      note(r.value.success ? "✅ 已清除" : `❌ ${r.value.message}`);
    });
  };

  const handleTest = () => {
    startTransition(async () => {
      const r = await runAction(
        () => testPushNotificationAction(value.trim() ? { wecom: value } : {}),
        (msg) => note(`❌ ${msg}`, 5000),
      );
      if (!r.ok) return;
      note(r.value.success ? "✅ 测试通知已发送到企业微信" : `❌ ${r.value.message}`, 5000);
    });
  };

  return (
    <div className="push-form">
      <div className="push-channel">
        <label>
          <strong>企业微信群机器人</strong>
          <span className="push-help">
            企业微信群 → 添加机器人 → 复制 Webhook
            {" · "}
            <a
              href="https://developer.work.weixin.qq.com/document/path/91770"
              target="_blank"
              rel="noopener noreferrer"
            >
              获取方法 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
            </a>
          </span>
        </label>
        <div className="push-input-row">
          <input
            type="text"
            className="push-input"
            placeholder={saved ? "已保存 ••••••（留空则保持不变）" : WECOM_PLACEHOLDER}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={isPending}
          />
          {saved ? (
            <button
              type="button"
              className="push-clear"
              title="清除企业微信 Webhook"
              onClick={handleClear}
              disabled={isPending}
            >
              <Trash2 size={13} aria-hidden />
              清除
            </button>
          ) : null}
        </div>
      </div>

      <div className="push-actions">
        <button className="primary-button" type="button" onClick={handleSave} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Bell size={14} aria-hidden />}
          保存配置
        </button>
        <button className="secondary-button" type="button" onClick={handleTest} disabled={isPending}>
          发送测试通知
        </button>
        {testResult ? <span className="push-result">{testResult}</span> : null}
      </div>
    </div>
  );
}
