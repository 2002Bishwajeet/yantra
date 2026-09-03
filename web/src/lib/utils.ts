import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// D3 §5.4's four sizes are `--text-*` tokens, and tailwind-merge reads an
// unknown `text-…` as a colour — so `text-meta` beside `text-muted-foreground`
// is dropped as a duplicate rather than kept as a size.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: { "font-size": [{ text: ["meta", "body", "group", "title"] }] },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
