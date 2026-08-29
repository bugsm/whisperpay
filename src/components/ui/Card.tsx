import { CARD_SURFACE } from "./surfaces";

/**
 * The container every page is built out of.
 *
 * Three copies of this existed before it lived here — `Card` in the payer view,
 * `Shell` on the public status page, `Panel` on the dashboard — each writing the
 * same class string out by hand. Keeping them in step worked right up until a
 * restyle, at which point one of them was always going to be missed.
 *
 * There is deliberately no `className` escape hatch. The moment a caller can
 * add "just one" utility, the shared surface stops being shared and this file
 * goes back to describing only some of the cards on screen.
 */
export default function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className={CARD_SURFACE}>
      {children}
    </section>
  );
}
