import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'yantra-web';

export const StartOnMachine = () => (
  <DropdownMenu open>
    <DropdownMenuTrigger render={<Button />}>Start claude</DropdownMenuTrigger>
    <DropdownMenuContent align="start" style={{ width: '15rem' }}>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Start on</DropdownMenuLabel>
        <DropdownMenuRadioGroup defaultValue="macbook">
          <DropdownMenuRadioItem value="macbook">macbook</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="cachyos-g14">cachyos-g14</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="pi" disabled>
            pi · unreachable
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Options</DropdownMenuLabel>
        <DropdownMenuCheckboxItem defaultChecked>Resume last session</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem variant="switch">Notify on ntfy</DropdownMenuCheckboxItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
);
