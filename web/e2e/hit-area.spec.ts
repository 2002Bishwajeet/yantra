import { ROUTES } from "./lib/routes";
import { expect, scenario, test } from "./lib/test";

/** Y-674 (#663, research note 25 F5): every tappable element on the phone reaches 44 px in both directions. */
const MIN = 44;

const TAPPABLE =
  "a[href], button, summary, [role=button], [role=tab], [role=radio], [role=switch], [role=checkbox], [role=option], [role=menuitem]";

for (const one of ROUTES) {
  test(`every tappable element on ${one.id} (${one.path}) is 44 px`, async ({
    page,
    size,
  }) => {
    test.skip(size !== "phone", "the 44 px rule is the phone rule");
    await scenario(page, ("scenario" in one && one.scenario) || "busy");
    await page.goto(one.path);
    await expect(page.locator(".m3-page").first()).toBeVisible();
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    // The phone FAB scales in, and a box measured mid-animation reads small.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ),
    );

    const offenders = await page.evaluate(
      ({ selector, min }) => {
        const found: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(selector)) {
          if (el.closest('[aria-hidden="true"], [inert]')) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (getComputedStyle(el).visibility === "hidden") continue;
          let [left, top, right, bottom] = [
            rect.left,
            rect.top,
            rect.right,
            rect.bottom,
          ];
          const after = getComputedStyle(el, "::after");
          if (after.content !== "none" && after.position === "absolute") {
            // Resolved offsets are measured inward from the box, so a negative one reaches outside it.
            left += Math.min(0, parseFloat(after.left) || 0);
            top += Math.min(0, parseFloat(after.top) || 0);
            right -= Math.min(0, parseFloat(after.right) || 0);
            bottom -= Math.min(0, parseFloat(after.bottom) || 0);
          }
          const [w, h] = [Math.round(right - left), Math.round(bottom - top)];
          if (w < min || h < min) {
            const name = el.id
              ? `#${el.id}`
              : `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/).join(".")}` : ""}`;
            found.push(
              `${name} ${w}x${h} "${(el.textContent ?? "").trim().slice(0, 30)}"`,
            );
          }
        }
        return found;
      },
      { selector: TAPPABLE, min: MIN },
    );
    expect(offenders.map((line) => `${one.path} ${line}`)).toEqual([]);
  });
}
