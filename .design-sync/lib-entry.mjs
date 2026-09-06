// Writes the library entry the Claude Design converter needs, since web/ is an
// app with no dist: web/dist-lib/index.js (bundled by esbuild) and
// web/index.d.ts (read by ts-morph for the props contracts), from the .d.ts
// files tsc emitted into web/dist-lib. Both outputs are gitignored.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const dts = 'web/dist-lib/components/ui';
const files = readdirSync(dts).filter((f) => f.endsWith('.d.ts')).map((f) => f.slice(0, -5)).filter((f) => f !== 'dialog-styles').sort();
for (const f of files) {
  const p = `${dts}/${f}.d.ts`;
  writeFileSync(p, readFileSync(p, 'utf8')
    .replaceAll('"@/components/ui/', '"./')
    .replaceAll('"@/lib/utils"', '"../../lib/utils"'));
}
// toggle.tsx and toggle-group.tsx both export a `Toggle`; a star export would
// make the name ambiguous, so the group's members are named.
const named = { 'toggle-group': ['ToggleGroup', 'ToggleGroupItem', 'ToggleGroupSeparator'] };
const line = (f, from) => named[f]
  ? `export { ${named[f].join(', ')} } from '${from}';`
  : `export * from '${from}';`;
writeFileSync('web/dist-lib/index.js', files.map((f) => line(f, `../src/components/ui/${f}.tsx`)).join('\n') + '\n');
writeFileSync('web/index.d.ts', files.map((f) => line(f, `./dist-lib/components/ui/${f}`)).join('\n') + '\n');
console.log(`lib entry: ${files.length} modules`);
