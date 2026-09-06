import { Toggle } from 'yantra-web';

export const Variants = () => (
  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
    <Toggle>Follow</Toggle>
    <Toggle defaultPressed>Follow</Toggle>
    <Toggle variant="outline">Wrap lines</Toggle>
    <Toggle variant="outline" defaultPressed>Wrap lines</Toggle>
    <Toggle variant="ghost">Timestamps</Toggle>
    <Toggle variant="ghost" defaultPressed>Timestamps</Toggle>
  </div>
);

export const Sizes = () => (
  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
    <Toggle size="xs" variant="outline">xs</Toggle>
    <Toggle size="sm" variant="outline">Attach</Toggle>
    <Toggle size="default" variant="outline">Attach</Toggle>
    <Toggle size="lg" variant="outline">Attach</Toggle>
  </div>
);

export const Disabled = () => (
  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
    <Toggle disabled>Follow</Toggle>
    <Toggle variant="outline" disabled>Wrap lines</Toggle>
    <Toggle variant="outline" disabled defaultPressed>Timestamps</Toggle>
  </div>
);
