/* Copied from T3 Code (MIT, (c) 2026 T3 Tools Inc.) at commit 963ebf5b.
   The import alias is the only change; see ./THIRD-PARTY.md. */
import { Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2Icon>) {
  return (
    <Loader2Icon
      aria-label="Loading"
      className={cn("animate-spin", className)}
      role="status"
      {...props}
    />
  );
}

export { Spinner };
