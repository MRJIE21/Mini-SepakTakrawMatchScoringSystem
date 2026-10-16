/* Alphabetic group labels, shared by school draw and schedule source labels. */
export function groupName(index, suffix = '组') {
  let letters = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    letters = String.fromCharCode(65 + (value - 1) % 26) + letters;
  }
  return letters + suffix;
}
