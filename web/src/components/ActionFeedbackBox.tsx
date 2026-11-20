"use client";

import { txUrl } from "@aevum-kit/aevum";
import type { ActionFeedback } from "@/lib/vaultTypes";

export function ActionFeedbackBox({
  feedback,
  hasExplorer,
}: {
  feedback: ActionFeedback | null;
  hasExplorer: boolean;
}) {
  if (!feedback) return null;
  return (
    <div className={`notice ${feedback.tone}`} role={feedback.tone === "bad" ? "alert" : "status"}>
      <div className="row-between">
        <strong>{feedback.title}</strong>
        {feedback.txHash && hasExplorer && (
          <a href={txUrl(feedback.txHash)} target="_blank" rel="noreferrer">
            Explorer Tx ↗
          </a>
        )}
      </div>
      <span>{feedback.detail}</span>
    </div>
  );
}
