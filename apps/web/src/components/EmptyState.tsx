import type { ReactNode } from "react";

export function EmptyState({
  glyph,
  title,
  body,
  action,
}: {
  glyph?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state-card">
      {glyph ? <div className="empty-state-glyph">{glyph}</div> : null}
      <strong>{title}</strong>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}
