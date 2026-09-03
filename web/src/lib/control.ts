/** The one control the ported set has no home for. Base UI's `Select` is a
 *  trigger and a hidden input, and `dashboard.test.tsx` drives the machine
 *  picker as an `HTMLSelectElement`, so a native `<select>` stays — and D3 §14
 *  gives `ui/select` to the row that adopts it.
 *
 *  Here rather than in a component, because three files had copied the string
 *  by the time D4 needed a fourth. */
export const nativeSelect =
  'border-input bg-background focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-[3px]'
