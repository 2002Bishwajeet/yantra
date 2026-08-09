/* Copied from T3 Code (MIT, (c) 2026 T3 Tools Inc.) at commit 963ebf5b.
   The import alias is the only change; see ./THIRD-PARTY.md. */
"use client";

import { Form as FormPrimitive } from "@base-ui/react/form";

import { cn } from "@/lib/utils";

function Form({ className, ...props }: FormPrimitive.Props) {
  return (
    <FormPrimitive
      className={cn("flex w-full flex-col gap-4", className)}
      data-slot="form"
      {...props}
    />
  );
}

export { Form };
