"use client";

import { useEffect } from "react";
import { getLastSeen, setLastSeen } from "../lib/notifications-seen";

/**
 * On the 通知 page: tag cards newer than the last-seen watermark with NEW (this
 * visit only), then advance the watermark to the newest — clearing the nav badge
 * and stopping future re-marking unless something newer arrives. Mounted in the
 * page's static shell (reliable hydration).
 *
 * The feed streams in from a Suspense boundary AFTER this mounts, and can take
 * longer than any fixed retry window on a cold DB. A MutationObserver keeps
 * scanning as cards arrive instead of guessing a timeout — the previous
 * 20×150ms retry gave up on slow feeds, leaving the badge unclearable. Every
 * card kind must carry `data-created-at` (including the folded 例行巡检 card).
 */
export function NotificationsSeenMarker() {
  useEffect(() => {
    let previous = getLastSeen();
    let scheduled = false;

    const advance = () => {
      scheduled = false;
      const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-created-at]"));
      let newest = previous;
      for (const card of cards) {
        const createdAt = card.dataset.createdAt ?? "";
        if (createdAt && createdAt > previous) {
          card.classList.add("is-new");
        }
        if (createdAt > newest) {
          newest = createdAt;
        }
      }
      if (newest && newest !== previous) {
        previous = newest;
        setLastSeen(newest);
      }
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      window.setTimeout(advance, 100);
    };

    advance();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
