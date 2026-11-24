/** A clause as the start of a line. Not for a name: `tmux` and `macOS` keep their own spelling. */
export const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1)
