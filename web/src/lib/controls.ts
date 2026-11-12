/** Text with no C0, DEL or C1 control, which a terminal obeys and a page does not
 *  draw. Tab and newline stay. So does `\p{Cf}`: a joined emoji needs its ZWJ. */
export function stripControls(text: string): string {
  return text.replace(/[^\P{Cc}\t\n]/gu, '')
}
