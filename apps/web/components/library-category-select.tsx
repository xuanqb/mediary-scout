"use client";

import { useState, useTransition } from "react";
import { useRouter } from "../lib/use-router";
import type { LibraryCategory } from "@media-track/workflow";
import { setTitleLibraryCategoryAction } from "../app/actions";
import { runAction } from "../lib/run-action";

const OPTIONS: Array<{ value: LibraryCategory; label: string }> = [
  { value: "movies", label: "电影" },
  { value: "tv", label: "电视剧" },
  { value: "variety", label: "综艺" },
  { value: "anime", label: "动漫" },
];

/** Manual shelf override. Existing tracked seasons keep their old directories;
 *  future acquisitions use the newly chosen category root. */
export function LibraryCategorySelect({
  titleId,
  initial,
}: {
  titleId: string;
  initial: LibraryCategory;
}) {
  const router = useRouter();
  const [value, setValue] = useState<LibraryCategory>(initial);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const change = (next: LibraryCategory) => {
    if (next === value) return;
    const previous = value;
    setValue(next);
    startTransition(async () => {
      const r = await runAction(
        () => setTitleLibraryCategoryAction({ titleId, category: next }),
        (message) => {
          setValue(previous);
          setError(message);
        },
      );
      if (!r.ok) return;
      if (!r.value.success) {
        setValue(previous);
        setError(r.value.message ?? "保存失败");
        return;
      }
      setError(null);
      router.refresh();
    });
  };

  return (
    <label className="library-category-select" title="媒体库分类">
      <span>分类</span>
      <select
        className="setting-control"
        value={value}
        disabled={isPending}
        onChange={(event) => change(event.target.value as LibraryCategory)}
        aria-label="媒体库分类"
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? <span className="tone-amber-text">{error}</span> : null}
    </label>
  );
}
