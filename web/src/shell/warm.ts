// Its own module so a test of the lazy loads can mock the warm-up away.
await Promise.all([import('./Account'), import('./BellPopover'), import('./Notifications'), import('./PalettePopup')])
