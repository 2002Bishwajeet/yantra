/** The three form factors from the canvas brief. The config runs one project
 *  per size, and a spec can pin one with `test.use(at('phone'))`. */
export const SIZES = {
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  tablet: {
    viewport: { width: 834, height: 1194 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  desktop: {
    viewport: { width: 1440, height: 1024 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
} as const

export type Size = keyof typeof SIZES

export const at = (size: Size) => SIZES[size]

export const FIXTURE_PORT = 7790
export const WEB_PORT = 4173
