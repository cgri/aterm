/**
 * The glyphs the tab bar draws, as SVG rather than text.
 *
 * Text glyphs were what put them out of line: `+`, `↑`, `◐`, `☀` and `☾` each come from a
 * different fallback font with a baseline of its own, so no one padding could centre
 * them all. A path has no baseline — flex-centred in its button it sits on the bar's
 * middle, which is where Windows draws the caption buttons beside them. They are drawn
 * the way those are: thin 1px strokes in `currentColor`, on a box of odd size where a
 * line has to fall on a pixel centre.
 */
const PATHS = {
  plus: [11, '<path d="M5.5 0v11M0 5.5h11"/>'],
  close: [8, '<path d="M.5.5l7 7M7.5.5l-7 7" stroke-width="1.2"/>'],
  update: [
    11,
    '<path d="M5.5 11V1M1.5 5l4-4 4 4" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>'
  ],
  system: [
    12,
    '<circle cx="6" cy="6" r="5.5"/><path d="M6 .5a5.5 5.5 0 0 0 0 11z" fill="currentColor" stroke="none"/>'
  ],
  light: [
    13,
    '<circle cx="6.5" cy="6.5" r="2.5"/>' +
      '<path d="M6.5 0v2M6.5 11v2M0 6.5h2M11 6.5h2M1.9 1.9l1.4 1.4M9.7 9.7l1.4 1.4M1.9 11.1l1.4-1.4M9.7 3.3l1.4-1.4"/>'
  ],
  dark: [12, '<path d="M10.5 7.6A5 5 0 0 1 4.4 1.5a5 5 0 1 0 6.1 6.1z" stroke-linejoin="round"/>']
} as const

export type IconName = keyof typeof PATHS

/** A fresh element each call: the tab bar is rebuilt wholesale, and a node has one parent. */
export function icon(name: IconName): SVGSVGElement {
  const [size, body] = PATHS[name]
  const template = document.createElement('template')
  template.innerHTML =
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" ` +
    `fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">${body}</svg>`
  return template.content.firstElementChild as SVGSVGElement
}
