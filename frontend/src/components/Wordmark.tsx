/**
 * The product name as it is drawn in a logo spot: the name in the text colour
 * with its closing "gard" in the brand green (WEB-SHELL-068). The name stays
 * one string — the title from the catalog (or the edition) — and only a title
 * that ends in "gard" is tinted, so any other title renders plain. The two
 * parts are adjacent text nodes, so the accessible name and `textContent` stay
 * exactly the title.
 */
export function Wordmark({ text }: { text: string }) {
  const match = /^(\S*\S)(gard)$/.exec(text);
  if (!match) return <>{text}</>;
  return (
    <>
      {match[1]}<span className="wordmark-accent" style={{ display: 'inline' }}>{match[2]}</span>
    </>
  );
}
