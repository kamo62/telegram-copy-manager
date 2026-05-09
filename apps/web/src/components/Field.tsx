export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field-pill">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
