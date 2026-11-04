"use client";

import { Check, LoaderCircle, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "../lib/use-router";
import { clearTgtoConfigAction, saveTgtoConfigAction } from "../app/actions";
import { runAction } from "../lib/run-action";

const SOURCE_OPTIONS = [
  { key: "re0", label: "RE0（115 转存分享）" },
  { key: "guanying", label: "观影（磁力，免费）" },
  { key: "seedhub", label: "SeedHub（磁力，较慢）" },
] as const;

export function TgtoConfigForm({
  baseUrl,
  tokenSet,
  maxPoints,
  sources,
}: {
  baseUrl: string;
  tokenSet: boolean;
  maxPoints: number;
  sources: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [url, setUrl] = useState(baseUrl);
  const [token, setToken] = useState("");
  const [limit, setLimit] = useState(String(maxPoints));
  const [selected, setSelected] = useState<string[]>(sources);
  const [result, setResult] = useState<string | null>(null);

  const toggleSource = (key: string) => {
    setSelected((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  };

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () =>
          saveTgtoConfigAction({
            baseUrl: url,
            token,
            maxPoints: Number.parseInt(limit, 10),
            sources: selected,
          }),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 4000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 保存成功（已实测可用）" : `❌ ${res.message ?? "保存失败"}`);
      if (res.success) {
        setToken("");
        router.refresh();
      }
      setTimeout(() => setResult(null), 4000);
    });
  };

  const handleClear = () => {
    startTransition(async () => {
      const r = await runAction(
        () => clearTgtoConfigAction(),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 4000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 已清除，Tgto 搜索源关闭" : `❌ ${res.message ?? "清除失败"}`);
      if (res.success) {
        setToken("");
        router.refresh();
      }
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="push-form">
      <div className="push-field">
        <label className="push-label">实例地址</label>
        <input
          type="text"
          className="setting-control"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="http://192.168.123.148:12366"
          aria-label="Tgto 实例地址"
          autoComplete="off"
        />
      </div>
      <div className="push-field">
        <label className="push-label">API Token（管理后台生成，形如 tgto__…）</label>
        <input
          type="password"
          className="setting-control"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={tokenSet ? "已设置（留空保持不变）" : "粘贴 Bearer Token"}
          aria-label="Tgto API Token"
          autoComplete="off"
        />
      </div>
      <div className="push-field">
        <label className="push-label">
          单条资源积分上限（0 = 只转已解锁/免费资源，绝不自动扣分）
        </label>
        <input
          type="number"
          min={0}
          step={1}
          className="setting-control"
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
          aria-label="Tgto 积分上限"
        />
      </div>
      <div className="push-field">
        <label className="push-label">资源来源</label>
        <div className="service-actions" style={{ flexWrap: "wrap" }}>
          {SOURCE_OPTIONS.map((option) => (
            <label key={option.key} className="panel-note" style={{ display: "inline-flex", gap: 6 }}>
              <input
                type="checkbox"
                checked={selected.includes(option.key)}
                onChange={() => toggleSource(option.key)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </div>
      <div className="service-actions">
        <button
          type="button"
          className="primary-button"
          onClick={handleSave}
          disabled={isPending || !url.trim()}
        >
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
        {tokenSet ? (
          <button type="button" className="secondary-button" onClick={handleClear} disabled={isPending}>
            <Trash2 size={14} aria-hidden />
            清除
          </button>
        ) : null}
        {result ? <span className="panel-note">{result}</span> : null}
      </div>
    </div>
  );
}
