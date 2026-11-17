/** The site's header, as the planner wears it.
 *
 * Every other page has it written in by the build (src/site/header.ts). The
 * planner is a React tree, so it draws its own from the same list of links
 * and the same class names, and the one stylesheet (site-head.css) lays
 * both out.
 *
 * Two things differ, on purpose. There is no "Start my plan" at the end: on
 * this page that is a link to where you are. And where the planner's chart
 * is up, the brand is the page's heading, as the toolbar's wordmark was:
 * it is what names the page for a screen reader, and `harness.spec.ts`
 * finds the planner by it.
 */
import { SITE_NAV } from "../site/header";

const HERE = "/plan/";

export function SiteHead({ heading = false }: { heading?: boolean }) {
  // The mark is decoration beside its own name, hence the empty alt. `<b>`
  // and not two spans, so "LionsDegree" stays one word (see header.ts).
  const brand = (
    <a className="brand" href="/" title="Back to the LionsDegree home page">
      <img src="/mark-clear.png" width={185} height={144} alt="" />
      <span><b>Lions</b>Degree</span>
    </a>
  );
  return (
    <div className="site-head">
      {heading ? <h1 className="brand-heading">{brand}</h1> : brand}
      <nav className="site-nav" aria-label="Site">
        {SITE_NAV.map(({ href, label }) => (
          <a key={href} href={href} aria-current={href === HERE ? "page" : undefined}>{label}</a>
        ))}
      </nav>
    </div>
  );
}
