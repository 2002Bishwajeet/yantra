/* Copied from T3 Code (MIT, (c) 2026 T3 Tools Inc.) at commit 963ebf5b.
   The import alias is the only change; see ./THIRD-PARTY.md. */
"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "@/lib/utils";

function Label({ className, render, ...props }: useRender.ComponentProps<"label">) {
  const defaultProps = {
    className: cn(
      "inline-flex items-center gap-2 text-base/4.5 sm:text-sm/4 font-medium text-foreground",
      className,
    ),
    "data-slot": "label",
  };

  return useRender({
    defaultTagName: "label",
    props: mergeProps<"label">(defaultProps, props),
    render,
  });
}

export { Label };
