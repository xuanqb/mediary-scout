"use client";

import { Check, LoaderCircle, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "../lib/use-router";
import { clearEmbyConfigAction, saveEmbyConfigAction } from "../app/actions";
import { runAction } from "../lib/run-action";
import type { EmbyLibraryNames } from "../lib/emby-client";

const LIBRARY_FIELDS: Array<{ key: keyof EmbyLibraryNames; label: string }> = [
  { key: "movies", label: "电影" },
  { key: "tv", label: "电视剧" },
  { key: "variety", label: "综艺" },
  { key: "anime", label: "动漫" },
];

/**
 * Emby 联动。保存时先真连一次 `/Library/MediaFolders`——地址填错、key 过期、
 * 容器和 Emby 不在同一网络，都在这一刻报出来；否则它会一路静默成「Emby 里
 * 没有」,把已有剧集又搜一遍。
 *
 * 「媒体库名称」指的是 Emby 里那几个媒体库的名字,不是磁盘目录名——我们是按
 * 名字找库 id,所以用户改名后这里也要跟着改。留空即用默认名。
 */
export function EmbyConfigForm({
  baseUrl,
  apiKeySet,
  libraryNames,
}: {
  baseUrl: string;
  apiKeySet: boolean;
  libraryNames: EmbyLibraryNames;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [url, setUrl] = useState(baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(apiKeySet);
  const [names, setNames] = useState<EmbyLibraryNames>(libraryNames);
  const [result, setResult] = useState<string | null>(null);

  const showResult = (message: string, ms = 5000) => {
    setResult(message);
    setTimeout(() => setResult(null), ms);
  };

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () => saveEmbyConfigAction({ baseUrl: url, apiKey, libraryNames: names }),
        (msg) => showResult(`❌ ${msg}`),
      );
      if (!r.ok) return;
      const res = r.value;
      showResult(res.success ? `✅ ${res.message ?? "保存成功"}` : `❌ ${res.message ?? "保存失败"}`);
      if (res.success) {
        setApiKey("");
        setHasKey(Boolean(url.trim()));
        router.refresh();
      }
    });
  };

  const handleClear = () => {
    startTransition(async () => {
      const r = await runAction(
        () => clearEmbyConfigAction(),
        (msg) => showResult(`❌ ${msg}`),
      );
      if (!r.ok) return;
      const res = r.value;
      showResult(res.success ? "✅ 已关闭 Emby 联动" : `❌ ${res.message ?? "清除失败"}`, 3000);
      if (res.success) {
        setUrl("");
        setApiKey("");
        setHasKey(false);
        router.refresh();
      }
    });
  };

  return (
    <div className="push-form">
      <div className="push-field">
        <label className="push-label">Emby 地址</label>
        <input
          type="url"
          className="setting-control"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="http://192.168.1.10:8096"
          aria-label="Emby 地址"
          autoComplete="off"
        />
      </div>
      <div className="push-field">
        <label className="push-label">API Key（Emby → 设置 → API 密钥）</label>
        <input
          type="password"
          className="setting-control"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasKey ? "已设置（填入新 Key 可替换）" : "粘贴 Emby API Key"}
          aria-label="Emby API Key"
          autoComplete="off"
        />
      </div>
      <div className="push-field">
        <label className="push-label">媒体库名称（按 Emby 里实际的名字填，留空用默认）</label>
        <div className="emby-library-fields">
          {LIBRARY_FIELDS.map((field) => (
            <label key={field.key} className="emby-library-field">
              <span>{field.label}</span>
              <input
                className="setting-control"
                value={names[field.key]}
                onChange={(event) =>
                  setNames((prev) => ({ ...prev, [field.key]: event.target.value }))
                }
                aria-label={`Emby ${field.label}媒体库名称`}
                autoComplete="off"
              />
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
        {hasKey ? (
          <button type="button" className="secondary-button" onClick={handleClear} disabled={isPending}>
            <Trash2 size={14} aria-hidden />
            关闭
          </button>
        ) : null}
        {result ? <span className="panel-note">{result}</span> : null}
      </div>
    </div>
  );
}
