/**
 * The card surface, as a class string rather than only as a component.
 *
 * `Card` covers the common case, but the surface is also worn by elements a
 * `<section>` can't stand in for — the create form and the withdraw form are
 * both `<form>`, and wrapping either in a card just to get the border would put
 * a div between the form and its own fields.
 *
 * Twelve hand-written copies of this string existed across the app. What made
 * that expensive wasn't the repetition, it was that no copy knew about the
 * others: a restyle had to find all twelve, and finding eleven looks exactly
 * like finding twelve until someone opens the twelfth page.
 */
export const CARD_SURFACE =
  "border-2 border-hairline bg-surface p-6 shadow-hard";

/**
 * The inset surface — inputs, and panels nested inside a card.
 *
 * Darker than the card it sits in rather than lighter, so depth reads as a hole
 * punched into the panel. That direction matters once shadows are hard: a
 * raised inset and a hard shadow describe two different light sources, and the
 * eye picks the contradiction out immediately.
 */
export const INSET_SURFACE = "border-2 border-hairline bg-background";
