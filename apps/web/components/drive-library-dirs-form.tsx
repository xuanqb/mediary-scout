"use client";

import { useState, useTransition } from "react";
import { useRouter } from "../lib/use-router";
import { Check, LoaderCircle } from "lucide-react";
import type { LibraryDirNames } from "../lib/workflow-runtime";
import { saveDriveLibraryDirsAction } from "../app/actions";
import { runAction } from "../lib/run-action";

const FIELDS: Array<{ key: keyof LibraryDirNames; label: string; fallback: string }> = [
  { key: "rootName", label: "媒体库根目录（可多级）", fallback: "影视 或 影音/影视" },
  { key: "moviesName", label: "电影", fallback: "电影" },
  { key: "tvName", label: "电视剧", fallback: "电视剧" },
  { key: "varietyName", label: "综艺", fallback: "综艺" },
  { key: "animeName", label: "动漫", fallback: "动漫" },
  { key: "mountPrefix", label: "SmartStrm 挂载前缀", fallback: "/115 或 /quark" },
];

/** Per-drive media tree layout. Values are single directory names; blank keeps
 *  the built-in default. Saving only resolves/creates dirs — old tracked seasons
 *  keep pointing at their existing directories. */
export function DriveLibraryDirsForm({
  storageId,
  initial,
}: {
  storageId: string;
  initial: LibraryDirNames;
}) {
  const router = useRouter();
  const [values, setValues] = useState<LibraryDirNames>(() => ({
    rootName: initial.rootName ?? "",
    moviesName: initial.moviesName ?? "",
    tvName: initial.tvName ?? "",
    varietyName: initial.varietyName ?? "",
    animeName: initial.animeName ?? "",
    mountPrefix: initial.mountPrefix ?? "",
  }));
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const save = () => {
    startTransition(async () => {
      const r = await runAction(
        () => saveDriveLibraryDirsAction({ storageId, dirs: values }),
        (message) => setNote(`❌ ${message}`),
      );
      if (!r.ok) return;
      if (r.value.success) {
        setNote("✅ 已保存");
        router.refresh();
      } else {
        setNote(`❌ ${r.value.message ?? "保存失败"}`);
      }
      setTimeout(() => setNote(null), 4000);
    });
  };

  return (
    <details className="drive-library-dirs">
      <summary>媒体库目录</summary>
      <div className="push-form">
        {FIELDS.map((field) => (
          <div className="push-field" key={field.key}>
            <label className="push-label">{field.label}</label>
            <input
              type="text"
              className="setting-control"
              value={values[field.key] ?? ""}
              placeholder={field.fallback}
              onChange={(event) =>
                setValues((previous) => ({ ...previous, [field.key]: event.target.value }))
              }
              aria-label={field.label}
            />
          </div>
        ))}
        <div className="service-actions">
          <button type="button" className="primary-button" disabled={isPending} onClick={save}>
            {isPending ? (
              <LoaderCircle size={14} className="spin" aria-hidden />
            ) : (
              <Check size={14} aria-hidden />
            )}
            保存目录
          </button>
        </div>
        <p className="panel-note">
          路径形如「根目录/分类」；根目录可填多级，如「影音/影视」，程序会逐级创建；
          分类目录仍是单层。留空使用默认值。已入库的旧剧集不会被移动。
          挂载前缀是这块盘在 SmartStrm 里的挂载点（如 /115），只用于拼自动化
          storage_path；留空按品牌默认值（/115、/quark）。
        </p>
        {note ? <p className="panel-note">{note}</p> : null}
      </div>
    </details>
  );
}
