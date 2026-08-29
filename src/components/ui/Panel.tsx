import Card from "./Card";

/** A `Card` that leads with a heading. */
export default function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <h1 className="mb-1 text-lg font-semibold">{title}</h1>
      {children}
    </Card>
  );
}
