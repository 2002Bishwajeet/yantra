/** BRIEF.md's canonical workspace colours; anything else hashes into them. */
const canonical: Record<string, string> = {
  'yantra-web': '#48674B',
  landing: '#7A6A45',
  'homelab-k8s': '#3F5F7A',
  appliance: '#4E6E7A',
  'agent-sdk': '#6B4E7A',
  'cargo-zig': '#3A5A5A',
  'docs-sweep': '#5A6E3A',
  'price-table': '#8A5A3A',
  'landing-copy': '#9A7A3A',
  'ntfy-relay': '#A85B3C',
}

const swatches = Object.values(canonical)

export function tileColor(name: string): string {
  const known = canonical[name]
  if (known) return known
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return swatches[hash % swatches.length]
}
