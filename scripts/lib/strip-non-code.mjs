/**
 * Blanks comments, and optionally string contents, while preserving line numbers and length.
 *
 * Shared by the source-scanning gates. A rule explained in its own doc comment must not be reported
 * as a violation of itself — that is not a hypothetical: the colour gate's first run flagged the
 * Tailwind class names in the sentence explaining why Tailwind class names are forbidden.
 *
 * Newlines and total length are preserved so a reported line and column still point at the file.
 */

/**
 * @param {string} src
 * @param {{ blankStrings?: boolean, lineComments?: boolean }} [options]
 *   `blankStrings` replaces string *contents* with `x` rather than whitespace: the purity gate needs
 *   it, because blanking a template literal to spaces makes `new Date(`${d}T00:00:00Z`)` look like an
 *   argument-less `new Date()`. A gate that reads CSS out of template literals must leave it off.
 *   `lineComments` is false for CSS, where `//` is not a comment.
 */
export function stripNonCode(src, options = {}) {
  const { blankStrings = false, lineComments = true } = options
  const out = src.split('')

  const blank = (from, to, fill = ' ') => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = fill
    }
  }

  const skipLineComment = (i) => {
    const end = src.indexOf('\n', i)
    const stop = end === -1 ? src.length : end
    blank(i, stop)
    return stop
  }

  const skipBlockComment = (i) => {
    const end = src.indexOf('*/', i + 2)
    const stop = end === -1 ? src.length : end + 2
    blank(i, stop)
    return stop
  }

  const skipString = (i) => {
    const quote = src[i]
    let k = i + 1
    while (k < src.length && src[k] !== quote) {
      if (src[k] === '\\') k += 1
      k += 1
    }
    if (blankStrings) blank(i + 1, Math.min(k, src.length), 'x')
    return Math.min(k + 1, src.length)
  }

  let i = 0
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (lineComments && two === '//') {
      i = skipLineComment(i)
    } else if (two === '/*') {
      i = skipBlockComment(i)
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      i = skipString(i)
    } else {
      i += 1
    }
  }
  return out.join('')
}
