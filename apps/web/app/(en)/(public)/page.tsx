/**
 * The public home route.
 *
 * A server component, rendering complete HTML. The real page is built by `W-SITE`; this exists so
 * that `W-SYS-01` has a route to prove the shell against — a theme, a direction and a font stack are
 * claims about rendered output, and there is no rendered output without a route.
 */
export default function HomePage() {
  return (
    <main>
      <h1>BE RELAX</h1>
      <p>Massage Center and Spa, Al Zahiyah, Abu Dhabi.</p>
    </main>
  )
}
