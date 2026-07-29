export function WorkspaceHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header className="workspace-heading">
      <div>
        <span className="workspace-eyebrow">{eyebrow}</span>
        {/* The page title is the document's top-level heading. The status bar
            names the app, which is chrome rather than the heading outline. */}
        <h1>{title}</h1>
      </div>
      <p>{description}</p>
    </header>
  );
}
