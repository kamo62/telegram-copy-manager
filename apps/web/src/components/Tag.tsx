export function Tag({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "good" | "warn" | "muted" | "up" | "down";
}) {
  return <span className={`tag ${tone}`}>{children}</span>;
}
