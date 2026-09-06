// Rewrites web/design/options/*.css so each option is a selectable palette:
// `:root` becomes `[data-palette="<name>"]`, which works on <html> or on any
// wrapper element. `today` is index.css's own values and stays the default.
import { readFileSync, writeFileSync } from 'node:fs';
const out = [];
out.push(`@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap");
`);
out.push(`/* Four candidate palettes from the Y-330 options round. Select one with
   data-palette="kalam" | "patta" | "neela" | "plex" on <html> or a wrapper.
   No attribute = the stock shadcn values in styles.css. data-theme="light" |
   "dark" on the same element forces a ground; otherwise the OS decides. */
[data-theme="light"] { color-scheme: light; }
[data-theme="dark"] { color-scheme: dark; }
`);
for (const name of ['kalam', 'patta', 'neela', 'plex']) {
  let css = readFileSync(`web/design/options/${name}.css`, 'utf8');
  css = css.replace(/^:root\[data-theme="(light|dark)"\][^\n]*\n/gm, '');
  css = css.replace(/^:root\s*\{/gm, `[data-palette="${name}"] {`);
  css = css.replace(/^html,\n/m, `[data-palette="${name}"],\n`);
  css = css.replace(/^\.(font-sans|font-heading|font-mono)/gm, `[data-palette="${name}"] .$1`);
  css = css.replace(/^\.(tone-warn|tone-ok)/gm, `[data-palette="${name}"] .$1`);
  if (name === 'plex') css = css.replace(/^\[data-palette="plex"\] \{/m, `[data-palette="plex"] {`);
  out.push(css.trim() + '\n');
}
writeFileSync('.design-sync/css/palettes.css', out.join('\n'));
