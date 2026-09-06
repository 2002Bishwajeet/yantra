# Building with Yantra

Yantra is a homelab fleet dashboard: one person, their own machines over a tailnet, often on a phone. The components are shadcn ports on Base UI, styled with Tailwind v4 classes and CSS tokens. Read `styles.css` (and its `@import`s) before styling anything.

## Setup

No provider is needed. Every component styles itself from the tokens in `styles.css`. Tooltips are the one exception: wrap a `Tooltip` in `TooltipProvider`.

Palette: the page renders on the stock shadcn values by default. Set `data-palette="kalam" | "patta" | "neela" | "plex"` on `<html>` or on a wrapper `<div>` to switch to one of the four candidate palettes (kalam = ink on paper, patta = cloth ground with indigo, neela = cool white with indigo, plex = kalam in IBM Plex). Light and dark follow the OS; force one with `data-theme="light"` or `data-theme="dark"` on the same element.

## Styling idiom

Use the component's props first (`variant`, `size`). For your own layout, use these Tailwind classes — they are the ones compiled into `_ds_bundle.css`; any other class silently does nothing:

| Family | Classes |
| --- | --- |
| layout | `flex` `inline-flex` `grid` `hidden` `flex-col` `flex-row` `flex-wrap` `flex-1` `shrink-0` `grow` `items-center` `items-start` `items-end` `items-baseline` `justify-between` `justify-center` `justify-start` `justify-end` `w-full` `h-full` `min-w-0` `mx-auto` `relative` `absolute` `sticky` `top-0` `inset-0` `truncate` `whitespace-nowrap` `overflow-hidden` `overflow-auto` `overflow-x-auto` |
| grid | `grid-cols-1` … `grid-cols-4` `grid-cols-6` `grid-cols-12` `col-span-2` `col-span-3` `col-span-4` `col-span-6` `col-span-12` |
| spacing | `gap-` `p-` `px-` `py-` `pt-` `pb-` `pl-` `pr-` `m-` `mx-` `my-` `mt-` `mb-` `ml-` `mr-` `space-y-` `space-x-` with steps `0 0.5 1 1.5 2 3 4 6 8 12` |
| sizes | `w-` `h-` `min-w-` `max-w-` `min-h-` `max-h-` with `4 5 6 8 10 12 16 24 32 48 64 80 96` |
| the dashboard's own tokens | `max-w-page` (the page column), `h-row` (one row: 3.5rem phone, 2.5rem desktop), `px-gutter` `gap-gutter`, `gap-group` `py-group` (between sections) |
| type | four sizes only: `text-meta` (0.75rem) `text-body` (0.875rem) `text-group` (1.125rem) `text-title` (1.5rem); `font-medium` `font-semibold` `font-mono` `font-sans` `font-heading` `tabular-nums` `uppercase` `tracking-wide` `leading-tight` `leading-snug` `leading-normal` |
| colour | `text-foreground` `text-muted-foreground` `text-primary` `text-destructive` `bg-background` `bg-card` `bg-muted` `bg-secondary` `bg-primary` `border-border` `hover:bg-muted` `hover:underline` |
| responsive | prefix any of the layout/grid classes with `sm:` `md:` `lg:` |

Everything else: inline `style={{}}` or `var(--token)`. Tokens you may read directly: `--background` `--foreground` `--card` `--muted` `--muted-foreground` `--primary` `--border` `--destructive` `--radius` `--tone-critical` `--tone-warn` `--tone-good`.

## Rules the dashboard keeps

- Four type sizes, never a fifth. Two row heights (`h-row`). One transition duration (150 ms, already on every component).
- State is shown by a mark plus a word, colour only tints it: put `className="mark tone-bad"` (needs you), `"mark tone-ok"` (running), `"mark tone-warn"`, `"mark tone-idle"`, `"mark tone-unknown"` on a `<span>` before the label. The accent (links, primary button) is never a state.
- Numbers sit in `font-mono tabular-nums`, right-aligned.
- Destructive verbs (Stop, Kill, Delete) always confirm first (`Dialog`).

## Example

```jsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, Button } from 'yantra-web';

export function Workspace() {
  return (
    <Card className="max-w-page">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="mark tone-ok" /> yantra
          <Badge variant="outline">macbook</Badge>
        </CardTitle>
        <CardDescription className="text-meta">running · 12 s ago</CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button>Attach</Button>
        <Button variant="outline">Transcript</Button>
        <Button variant="destructive-outline">Stop</Button>
      </CardContent>
    </Card>
  );
}
```
