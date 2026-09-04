import { Button, Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from 'yantra-web';

export const Recheck = () => (
  <TooltipProvider>
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '3.5rem' }}>
      <Tooltip open>
        <TooltipTrigger render={<Button variant="outline" size="sm" />}>Re-check</TooltipTrigger>
        <TooltipPopup>Ask macbook again. Last reply 40 s ago.</TooltipPopup>
      </Tooltip>
    </div>
  </TooltipProvider>
);

export const Shortcut = () => (
  <TooltipProvider>
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '3.5rem' }}>
      <Tooltip open>
        <TooltipTrigger render={<Button variant="ghost" size="sm" />}>Search</TooltipTrigger>
        <TooltipPopup variant="glass" side="bottom">Command palette. Press ⌘K.</TooltipPopup>
      </Tooltip>
    </div>
  </TooltipProvider>
);
