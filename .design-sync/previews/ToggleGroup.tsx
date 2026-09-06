import { ToggleGroup, ToggleGroupItem } from 'yantra-web';

export const FilterByState = () => (
  <ToggleGroup defaultValue={['running']}>
    <ToggleGroupItem value="running">Running</ToggleGroupItem>
    <ToggleGroupItem value="awaiting">Awaiting trust</ToggleGroupItem>
    <ToggleGroupItem value="crashed">Crashed</ToggleGroupItem>
    <ToggleGroupItem value="idle">Idle</ToggleGroupItem>
  </ToggleGroup>
);

export const Outline = () => (
  <ToggleGroup variant="outline" defaultValue={['macbook']}>
    <ToggleGroupItem value="macbook">macbook</ToggleGroupItem>
    <ToggleGroupItem value="cachyos-g14">cachyos-g14</ToggleGroupItem>
    <ToggleGroupItem value="pi">pi</ToggleGroupItem>
  </ToggleGroup>
);

export const Multiple = () => (
  <ToggleGroup variant="outline" size="sm" multiple defaultValue={['wrap', 'time']}>
    <ToggleGroupItem value="follow">Follow</ToggleGroupItem>
    <ToggleGroupItem value="wrap">Wrap lines</ToggleGroupItem>
    <ToggleGroupItem value="time">Timestamps</ToggleGroupItem>
  </ToggleGroup>
);

export const Vertical = () => (
  <ToggleGroup variant="outline" orientation="vertical" defaultValue={['transcript']}>
    <ToggleGroupItem value="terminal">Terminal</ToggleGroupItem>
    <ToggleGroupItem value="transcript">Transcript</ToggleGroupItem>
    <ToggleGroupItem value="usage">Usage</ToggleGroupItem>
  </ToggleGroup>
);
